// Executor and continuation records (#309). Each implement/fix round names the executor that ran it; a round interrupted
// by a quota limit resumes as the same round; probing an unavailable candidate never counts as an attempt.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unavailableReason } from './fallback.mjs';

// Candidate unavailability outlives a pass: each daemon pass is a new process, so the records are kept in the state directory.
export const CANDIDATE_RECORDS_PATH = '.roundtable/state/candidate-records.json';
export function loadCandidateRecords(root) {
  const file = join(root, CANDIDATE_RECORDS_PATH);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}
export function saveCandidateRecords(root, records) {
  const file = join(root, CANDIDATE_RECORDS_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(records));
  renameSync(`${file}.tmp`, file);
}

// A degraded (non-preferred) candidate is not independent: it never counts as a Gate 1 pass.
export const executorOf = (candidate, { role = 'developer', degraded = false, independent = !degraded } = {}) =>
  ({ role, harness: candidate.harness, model: candidate.model, degraded, independent });

export const openContinuation = () => ({ counters: { implement: 0, fix: 0 }, rounds: [], degraded: false });

const lastRound = (cont) => cont.rounds.at(-1);

export function startRound(cont, kind, executor) {
  cont.counters[kind] += 1;
  cont.rounds.push({ kind, n: cont.counters[kind], status: 'running', executors: [executor] });
  cont.degraded ||= executor.degraded;
}

export function resumeRound(cont, executor) {
  const round = lastRound(cont);
  round.status = 'running';
  round.executors.push(executor);
  cont.degraded ||= executor.degraded;
}

export function interruptRound(cont, reason, executor) {
  const round = lastRound(cont);
  round.status = 'interrupted';
  (round.interruptions ??= []).push({ reason, executor });
}

export const closeRound = (cont, status) => { lastRound(cont).status = status; };

// Gate 1 passes only for a review by an independent executor (a separate session), never a Chief-implemented round.
export const gate1Pass = (executor, verdict) => verdict === 'passed' && executor.independent === true;

/**
 * One implement/fix round on `role`'s candidates (#309). Unavailable candidates that reopened, or were not tried for a
 * probe interval, are probed first with the cheap `probe` call (no worker, no attempt; skipped when `probe` is absent).
 * When every candidate is unavailable, the round returns a `quota_wait` record with `unblockAt` and writes the due timer
 * `timerId` at the earlier of the unblock time and the next probe; no worker runs before the unblock time. A worker that hits a limit mid-session
 * interrupts the round, and the next candidate resumes it as the same round.
 */
export async function runRound({ router, role, cont, kind, timers, timerId, event, probe, worker }) {
  const wait = () => {
    const probeAt = router.nextProbeAt(role);
    timers.once({ id: timerId, at: new Date(probeAt).toISOString(), event });
    return { class: 'quota_wait', decision: 'wait', status: 'waiting_external', unblockAt: router.unblockAt(role) ?? probeAt, probeAt };
  };
  if (probe) await router.probe(role, probe);
  if (router.unblockAt(role) !== undefined) return wait();
  const outcome = await router(role, async (candidate) => {
    const executor = executorOf(candidate, { role, degraded: candidate !== router.candidates[role][0] });
    if (lastRound(cont)?.status === 'interrupted') resumeRound(cont, executor); else startRound(cont, kind, executor);
    let result;
    try { result = await worker(candidate); } catch (error) { if (!unavailableReason(error)) throw error; result = error; }
    const reason = unavailableReason(result);
    if (reason) interruptRound(cont, reason, executor); else closeRound(cont, 'returned');
    return result;
  });
  return unavailableReason(outcome) ? wait() : outcome;
}
