export const isBalanceError = (error) => error?.status === 402 || error?.statusCode === 402;

/** Budget exhaustion is a quota limit on the same wait-and-probe path as a balance error (#64), not no-progress or a block. */
export const isQuotaLimit = (event) => event?.reason === 'budget_exhausted';

/**
 * Route calls by role. A balance error (HTTP 402) on a role's primary model switches every role
 * sharing that harness to the configured fallback model until `now() + ttlMs`, and re-runs the
 * failed call once on the fallback. Other errors propagate unchanged.
 * `routes`: role -> { harness, model }; `fallback`: harness -> model.
 */
export function createFallbackRouter({ routes, fallback, ttlMs, now }) {
  for (const { harness } of Object.values(routes)) {
    if (typeof fallback?.[harness] !== 'string' || fallback[harness].trim() === '') {
      throw new TypeError(`a fallback model must be configured for harness "${harness}"`);
    }
  }
  const switchedUntil = new Map();

  return async function call(role, invoke) {
    const { harness, model } = routes[role];
    const until = switchedUntil.get(harness);
    if (until !== undefined && now() < until) return invoke(fallback[harness]);
    try {
      return await invoke(model);
    } catch (error) {
      if (!isBalanceError(error)) throw error;
      switchedUntil.set(harness, now() + ttlMs);
      return invoke(fallback[harness]);
    }
  };
}

export const isRateLimit = (error) => error?.status === 429 || error?.statusCode === 429;

/** Why a candidate cannot serve a call, or null. A timeout counts only when it produced no output (#308). */
export function unavailableReason(outcome) {
  if (isBalanceError(outcome)) return '402';
  if (isRateLimit(outcome)) return '429';
  if (isQuotaLimit(outcome)) return 'quota';
  if (outcome?.timedOut && !(typeof outcome.output === 'string' && outcome.output.trim() !== '')) return 'timeout';
  return null;
}

// Retry-After as delta-seconds or an HTTP date; `retryAfter` is the same field under the host's name.
function retryAtOf(error, at) {
  const raw = error?.retryAfter ?? error?.headers?.['retry-after'] ?? error?.headers?.['Retry-After'];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return at + seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : date;
}

/**
 * Candidate-level fallback over the ordered per-role list (#308). A call tries each candidate in order and skips a
 * candidate that is still unavailable. A 402, 429, quota, or output-less timeout marks that candidate unavailable until
 * its `retryAt` (from the error's Retry-After) or `ttlMs` later. Other outcomes are returned for classify() to judge, so
 * the router spends no budget. When every candidate is unavailable, the last failure is returned for classify().
 * `candidates`: role -> [{ harness, model }]. `call(role, invoke, { authorSession })` skips a reviewer candidate whose
 * session (`session`, else `harness`) equals `authorSession`, the author's own session.
 */
export function createCandidateRouter({ candidates, ttlMs = 10 * 60_000, now = Date.now, probeIntervalMs = 10 * 60_000, records: seeded = [] }) {
  const records = new Map();
  const outages = new Map();
  const keyOf = (candidate) => JSON.stringify([candidate.harness, candidate.model]);
  for (const record of seeded) records.set(keyOf(record), record); // unavailability carried over from earlier passes (#309)
  const isOpen = (candidate) => {
    const record = records.get(keyOf(candidate));
    return !record || now() >= (record.retryAt ?? record.at + ttlMs);
  };
  const outageOf = (role) => {
    if (!outages.has(role)) outages.set(role, { cycles: 0, wallMs: 0, since: undefined });
    return outages.get(role);
  };
  // Runs one candidate and records its outcome; returns the outcome and whether it is available.
  async function attempt(role, candidate, invoke) {
    let outcome;
    try {
      outcome = await invoke(candidate);
    } catch (error) {
      if (!unavailableReason(error)) throw error;
      outcome = error;
    }
    const reason = unavailableReason(outcome);
    if (!reason) {
      records.delete(keyOf(candidate));
      const outage = outageOf(role);
      if (outage.since !== undefined) { outage.wallMs += now() - outage.since; outage.since = undefined; }
      return { outcome, available: true };
    }
    const at = now();
    records.set(keyOf(candidate), { role, harness: candidate.harness, model: candidate.model, reason, at, retryAt: retryAtOf(outcome, at), outcome });
    return { outcome, available: false };
  }

  async function call(role, invoke, { authorSession } = {}) {
    let last;
    for (const candidate of candidates[role]) {
      if (role === 'reviewer' && authorSession !== undefined && (candidate.session ?? candidate.harness) === authorSession) continue;
      if (!isOpen(candidate)) continue;
      const { outcome, available } = await attempt(role, candidate, invoke);
      if (available) return outcome;
      last = outcome;
    }
    const outage = outageOf(role);
    outage.cycles += 1;
    outage.since ??= now();
    const latest = candidates[role].map((candidate) => records.get(keyOf(candidate))).filter(Boolean).sort((a, b) => b.at - a.at)[0];
    return last ?? latest?.outcome ?? { unavailable: true };
  }

  call.unavailable = () => [...records.values()].map(({ outcome, ...record }) => record);
  call.candidates = candidates;
  // Earliest time every candidate of `role` is unavailable again, or undefined while one is open (#309).
  call.unblockAt = (role) => {
    const until = candidates[role].map((c) => records.get(keyOf(c)))
      .map((r) => r && (r.retryAt ?? r.at + ttlMs));
    return until.every((t) => t !== undefined && now() < t) ? Math.min(...until) : undefined;
  };
  // True when a candidate of `role` was unavailable and its time has passed, so it must be probed before work (#309).
  call.reopened = (role) => candidates[role].some((c) => records.has(keyOf(c)) && isOpen(c));
  // Probes each unavailable candidate that has reopened or has not been tried for `probeIntervalMs`. A probe is a cheap
  // `invoke` (never a worker): it spends no attempt and adds no outage cycle, but a success clears the candidate and ends an open outage's wallMs.
  call.probe = async (role, invoke) => {
    for (const candidate of candidates[role]) {
      const record = records.get(keyOf(candidate));
      if (record && (isOpen(candidate) || now() >= record.at + probeIntervalMs)) await attempt(role, candidate, invoke);
    }
  };
  // The next time to look at `role` again while every candidate is unavailable: the probe interval or the unblock time, whichever is first.
  call.nextProbeAt = (role) => Math.min(...[call.unblockAt(role), now() + probeIntervalMs].filter(Number.isFinite));
  call.unavailableStats = (role) => {
    const outage = outageOf(role);
    return { cycles: outage.cycles, wallMs: outage.wallMs + (outage.since === undefined ? 0 : now() - outage.since) };
  };
  return call;
}

/** Wait until `until`, running the injected main-CI check on every pass (at least once). */
export async function waitForUsageLimit({ until, now, sleep, intervalMs, checkMainCi }) {
  do {
    await checkMainCi();
    await sleep(intervalMs);
  } while (now() < until);
}
