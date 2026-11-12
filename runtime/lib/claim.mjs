import { acquireLock } from './lock.mjs';
import { assertSafeId } from './paths.mjs';

export const CLAIM_LABEL = 'rt:running';
export const CLAIM_MARKER = '<!-- rt:claim -->';

const labelsOf = (issue) => (issue.labels ?? []).map((label) => typeof label === 'string' ? label : label.name);

/** Coordinate idempotent claims and stale orphan recovery using an injected tracker client. */
export function createClaimCoordinator({ client, stateRoot, repoRoot, loadState, isStale, isInFlight, worktreeManager, resume, beforeClaim = async () => {}, afterClaim = async () => {}, canResume = (state) => state.status === 'working', workerSlot = 1, now = Date.now }) {
  if (!client || !stateRoot || typeof loadState !== 'function' || typeof resume !== 'function') throw new TypeError('client, stateRoot, loadState, and resume are required');
  const inFlight = isInFlight ?? (worktreeManager ? async (issue) => {
    const status = await worktreeManager.inspect(issue.number ?? issue.id);
    return status.heldLock || (!labelsOf(issue).includes(CLAIM_LABEL) && status.liveWorktree);
  } : async () => false);
  return { tick: (issues) => tickClaims({ client, stateRoot, repoRoot, issues, loadState, isStale, isInFlight: inFlight, resume, beforeClaim, afterClaim, canResume, workerSlot, now }) };
}

export async function tickClaims({ client, stateRoot, repoRoot, issues, loadState, isStale = async (state) => !state.lease || state.lease.expiresAt <= Date.now(), isInFlight = async () => false, resume, beforeClaim = async () => {}, afterClaim = async () => {}, canResume = (state) => state.status === 'working', workerSlot = 1, now = Date.now }) {
  if (!client || !Array.isArray(issues) || typeof loadState !== 'function') throw new TypeError('client, issues, and loadState are required');
  const result = { claimed: 0, resumed: 0, skipped: [] };
  for (const issue of issues) {
    const id = assertSafeId(issue.number ?? issue.id);
    // The claim lock namespace is the state root it guards (default); callers with a repo root pass it explicitly.
    const lock = await acquireLock({ lockPath: `${stateRoot}/${id}.claim.lock.d`, repoRoot: repoRoot ?? stateRoot, owner: `claim-${process.pid}-${id}`, now, ttlMs: 60_000 });
    if (!lock.acquired) { result.skipped.push({ id, reason: 'claim_locked' }); continue; }
    try {
      const state = await loadState(id);
      if (labelsOf(issue).includes(CLAIM_LABEL)) {
        if (await isInFlight(issue, state)) { result.skipped.push({ id, reason: 'in_flight' }); continue; }
        if (canResume(state) && await isStale(state)) {
          if (typeof resume !== 'function') throw new TypeError('resume is required for stale claims');
          await resume(issue, state);
          result.resumed++;
        } else result.skipped.push({ id, reason: 'already_claimed' });
        continue;
      }
      if (await isInFlight(issue, state)) { result.skipped.push({ id, reason: 'in_flight' }); continue; }
      // Refresh comments before writing so repeated ticks (and a restarted daemon) preserve one marker.
      const comments = typeof client.listComments === 'function' ? await client.listComments(issue.number ?? issue.id) : issue.comments ?? [];
      const hasMarker = comments.some((comment) => String(comment.body ?? comment).includes(CLAIM_MARKER));
      await beforeClaim(issue, state);
      await client.addLabel(issue.number ?? issue.id, CLAIM_LABEL);
      if (!hasMarker) await client.createComment(issue.number ?? issue.id, `${CLAIM_MARKER}\nClaimed by the roundtable loop (worker slot ${workerSlot}).`);
      await afterClaim(issue, state);
      result.claimed++;
    } finally { await lock.release().catch(() => false); }
  }
  return result;
}
