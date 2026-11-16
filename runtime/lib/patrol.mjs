const MIN = 60_000;
const STALE_WORK_MS = 90 * MIN;
const ERROR_WINDOW_MS = 6 * 60 * MIN;
const ERROR_REPEAT = 3;
const STALE_MS = 30 * MIN;
const DECIDER_RETRIES = 3;

const finding = (row, key, action, detail) => ({ row, signature: `${row}:${key}`, action, detail });

/**
 * P2: working items with no state change past 90 min.
 * @param {{ now: number, items: Array<{ id: string, state: string, since: number, staleHits: number, requeued: boolean }> }} input
 *   `since` = time of last state change; `staleHits` = prior consecutive stale observations.
 */
export function detectP2({ now, items }) {
  return items.filter((i) => i.state === 'working' && now - i.since > STALE_WORK_MS).map((i) => {
    const hits = i.staleHits + 1;
    const action = hits < 2 ? 'observe' : i.requeued ? 'block' : 'requeue';
    return finding('P2', `${i.id}:${i.since}`, action, { id: i.id, hits });
  });
}

/**
 * P3: one error fingerprint recorded 3+ times in the last 6 h.
 * @param {{ now: number, errors: Array<{ fingerprint: string, at: number }> }} input
 */
export function detectP3({ now, errors }) {
  const counts = new Map();
  for (const e of errors) if (now - e.at <= ERROR_WINDOW_MS) counts.set(e.fingerprint, (counts.get(e.fingerprint) ?? 0) + 1);
  return [...counts].filter(([, count]) => count >= ERROR_REPEAT).map(([fingerprint, count]) =>
    finding('P3', fingerprint, 'pause_claims_file_self_issue', { fingerprint, count }));
}

/**
 * P4: main CI is red.
 * @param {{ main: { state: 'red' | 'green' | 'pending', sha: string, loopMerge: boolean } }} input
 */
export function detectP4({ main }) {
  if (main.state !== 'red') return [];
  return [finding('P4', main.sha, main.loopMerge ? 'revert_candidate' : 'pause_claims', { sha: main.sha })];
}

/**
 * P5: leak-check hits in public text. Content is never echoed; only location and kind.
 * @param {{ leakHits: Array<{ location: string, kind: string }> }} input
 */
export function detectP5({ leakHits }) {
  return leakHits.map((h) => finding('P5', `${h.location}:${h.kind}`, 'redact_candidate', { location: h.location, kind: h.kind }));
}

/**
 * P6: rt:ask / rt:blocked items that have a default decision available.
 * @param {{ items: Array<{ id: string, label: string, needsDefault: boolean, decideAttempts: number }> }} input
 */
export function detectP6({ items }) {
  return items.filter((i) => ['rt:ask', 'rt:blocked'].includes(i.label) && i.needsDefault).map((i) =>
    finding('P6', `${i.id}:${i.label}`, i.decideAttempts < DECIDER_RETRIES ? 'retry_decider' : 'ask_policy_candidate', { id: i.id, attempts: i.decideAttempts }));
}

/**
 * P7: open issues/PRs whose verified done evidence holds.
 * @param {{ items: Array<{ id: number, kind: 'issue' | 'pr', state: 'open' | 'closed', verifiedDone: boolean }> }} input
 */
export function detectP7({ items }) {
  return items.filter((i) => i.state === 'open' && i.verifiedDone).map((i) =>
    finding('P7', `${i.kind}:${i.id}`, 'close_candidate', { kind: i.kind, id: i.id }));
}

/**
 * P8: open PRs with passed gates and green CI that policy allows to merge.
 * @param {{ prs: Array<{ number: number, headSha: string, state: 'open' | 'closed', gatesPassed: boolean, ci: string, policyAllowsMerge: boolean }> }} input
 */
export function detectP8({ prs }) {
  return prs.filter((p) => p.state === 'open' && p.gatesPassed && p.ci === 'green' && p.policyAllowsMerge).map((p) =>
    finding('P8', `${p.number}:${p.headSha}`, 'merge_candidate', { number: p.number }));
}

/**
 * P9: locks and temp files not touched for 30 min.
 * @param {{ now: number, locks: Array<{ path: string, heartbeat: number }>, temps: Array<{ path: string, mtime: number }> }} input
 *   Paths are workspace-relative.
 */
export function detectP9({ now, locks, temps }) {
  const aged = [...locks.map((l) => ['lock', l.path, l.heartbeat]), ...temps.map((t) => ['temp', t.path, t.mtime])];
  return aged.filter(([, , at]) => now - at > STALE_MS).map(([kind, path]) =>
    finding('P9', `${kind}:${path}`, 'prune_candidate', { kind, path }));
}
