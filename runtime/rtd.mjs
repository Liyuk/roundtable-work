#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PathEscapeError } from './lib/paths.mjs';
import { acquireLock } from './lib/lock.mjs';
import { readQueue, isTerminal } from './lib/queue.mjs';
import { randomUUID } from 'node:crypto';
import { createStateStore, PHASES, CorruptStateError, StaleEpochError } from './lib/state.mjs';
import { classify } from './lib/classify.mjs';
import { createIntakeProvider } from './lib/intake.mjs';
import { createGitHubReader, createGitHubWriter } from '../scripts/github-read.mjs';
import { CLAIM_MARKER, createClaimCoordinator } from './lib/claim.mjs';
import { runWorkers } from './lib/workers.mjs';
import { createWorktreeManager } from './lib/worktree.mjs';

const STAGE = { developing: 'developer', testing: 'test', reviewing: 'reviewer', finalizing: 'finalize' };
export const EXIT_LOCKED = 75;
export const EXIT_LOCK_LOST = 76;

/**
 * Process exit code for a `runQueue` result: 0 ok, 75 locked (another pass is running), 76 lock lost (pass aborted).
 * `abandonedHandler` does not change the code; the CLI additionally ends the process (see `runQueue`).
 */
export function exitCodeFor(result) {
  if (result?.status === 'locked') return EXIT_LOCKED;
  if (result?.status === 'lock_lost') return EXIT_LOCK_LOST;
  return 0;
}

/**
 * One pass over the queue: each runnable issue gets at most one wake.
 *
 * `handler({ item, phase, stage, state, heartbeat, recordArtifacts, signal })` performs one phase and returns
 * `{ exitCode, timedOut, output, scopeMismatch, humanBlock, artifacts, changedFiles }`.
 * It must not delete worktree / diff / output artifacts; it reports their paths (returned or via
 * `recordArtifacts`, which persists them immediately so a crash cannot lose the record).
 *
 * A failed or timed-out `finalizing` step ends the wake as `interrupted` (decision `ask`, class
 * `finalize_failure`, `recovery.resumePhase = 'finalizing'`): it is not retried from development and
 * spends no developer retry. A `PathEscapeError` thrown by the handler's own `recordArtifacts()` is a
 * scope mismatch (`out-of-scope`), not a developer failure.
 *
 * Liveness contract: the single-flight lock has a lease of `lockTtlMs`. It is renewed at the start of
 * every wake and phase, by every `heartbeat()` call, and automatically on an unref'd timer while the
 * queue is being read (an injected queue provider may run for any length of time) and while a handler runs
 * (every `max(lockRenewMinMs, floor(lockTtlMs / 3))` ms, `lockRenewMinMs` defaults to 1000; a `TypeError` is
 * thrown up front unless both are positive and `lockRenewMinMs <= lockTtlMs / 2`), so a quiet
 * provider or handler keeps the lock and no other process can run the same queue meanwhile. `heartbeat()` stays
 * available as an extra liveness signal for the per-issue lease. When the lock is lost (a refresh fails
 * or throws) the `signal` passed to the handler is aborted and the wake is aborted once the handler
 * settles. The lock is also checked once after the queue was read and again as the very first step of every
 * wake, before any per-issue state is read or written: a pass that lost the lock while the queue was being
 * read returns `lock_lost` with no outcomes and never starts a wake. No further handler runs, nothing more is recorded for the interrupted phase (the handler's
 * own `recordArtifacts()` / `heartbeat()` calls reject), the other process's lock is left alone,
 * per-issue state and artifacts are kept, and nothing at all is written for the issue afterwards (the
 * issue lease is not released; it expires on its own and the successor owns the state).
 * The pass then returns `{ status:'lock_lost', outcomes, skipped }` (outcomes holds finished issues
 * and the interrupted one with `status:'lock_lost'`; it is empty when the lock was lost while the queue was read). The CLI exits 0 for `ok`, 75 (`EXIT_LOCKED`) for
 * `locked` and 76 (`EXIT_LOCK_LOST`) for `lock_lost`, see `exitCodeFor()`.
 *
 * Hardening: a handler result that is not a plain object (undefined, null, ...) is a failure; success is a numeric
 * `exitCode === 0` with no `signal` (see classify). `phaseTimeoutMs` (default 1 h) aborts a handler that does not settle
 * (its `signal` fires and the step is classified as a timeout for its stage); `queueTimeoutMs` (default 10 min) rejects
 * `runQueue` with `code: 'RT_QUEUE_TIMEOUT'` for a queue provider that does not settle (both release the lock;
 * `Infinity` disables). A phase that times out is closed: the handler may keep running (it is only signalled), but its
 * `heartbeat()` and `recordArtifacts()` throw `phase closed` and write nothing from then on. The wake waits up to
 * `graceMs` (default 5 s) for the abandoned handler to settle, records a recoverable state and ends: a timed-out
 * developer or test phase spends one developer retry and leaves the issue `queued` (resume from developing, outcome
 * status `queued`, decision `wait`; the retry budget still applies), a timed-out reviewer is `waiting_external`, a timed-out
 * finalizing is `interrupted`. No new phase or retry starts in the same wake, so work on one issue never overlaps and
 * the lease is only released after the handler settles; the next wake resumes. The phase
 * and queue timeout timers keep the process alive (not unref'd), so a never-settling handler or queue provider ends
 * with the timeout recorded (or `RT_QUEUE_TIMEOUT` thrown) instead of a silent exit. State writes are fenced by the lock epoch (`StaleEpochError` -> `lock_lost`). A corrupt state
 * file ends that issue as `{status:'failed', reason:'corrupt_state', decision:'ask'}` and the file is left untouched; the pass
 * continues. The default `owner` is unique per call. One work root per queue: the lock is per work root.
 *
 * Abandoned handlers retain the queue lock and issue lease with background renewal until they settle.
 * No further work starts in the pass. The CLI exits after recording the recoverable state.
 *
 * CLI: `rtd.mjs --work-root DIR --queue FILE --handler MODULE [--phase-timeout-ms N] [--queue-timeout-ms N] [--grace-ms N]`. `--handler` is trusted operator code,
 * deliberately outside work-root confinement (only paths under the work root are confined).
 *
 * @returns {Promise<{status:'locked', holder:object} | {status:'lock_lost', outcomes:object[], skipped:object[], abandonedHandler?:true} | {status:'ok', outcomes:object[], skipped:object[], abandonedHandler?:true}>}
 */
export async function runQueue({
  workRoot, queue, handler, now = Date.now, owner = `rtd-${process.pid}-${randomUUID()}`,
  leaseTtlMs = 60_000, heartbeatTimeoutMs = 120_000, lockTtlMs = 5 * 60_000, lockRenewMinMs = 1000,
  maxWakesPerIssue = 5, maxDeveloperAttempts = 3, maxReviewerUnavailable = 5,
  phaseTimeoutMs = 60 * 60_000, queueTimeoutMs = 10 * 60_000, graceMs = 5000,
  githubClient, repoRoot, workers = 2, baseBranch = 'main',
}) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  if (githubClient && !repoRoot) throw new TypeError('repoRoot is required for tracker workers');
  // The lock must be renewed well before it expires: at least two renewals fit into one lease.
  for (const [name, value] of [['lockTtlMs', lockTtlMs], ['lockRenewMinMs', lockRenewMinMs], ['leaseTtlMs', leaseTtlMs]]) {
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new TypeError(`${name} must be a positive number`);
  }
  for (const [name, value] of [['phaseTimeoutMs', phaseTimeoutMs], ['queueTimeoutMs', queueTimeoutMs]]) {
    if (!(typeof value === 'number' && value > 0)) throw new TypeError(`${name} must be a positive number (Infinity disables it)`);
  }
  if (!(typeof graceMs === 'number' && Number.isFinite(graceMs) && graceMs >= 0)) throw new TypeError('graceMs must be a non-negative number');
  if (lockRenewMinMs > lockTtlMs / 2) throw new TypeError(`lockRenewMinMs (${lockRenewMinMs}) must be <= lockTtlMs / 2 (${lockTtlMs / 2}), otherwise the lock can expire before its first renewal`);
  await mkdir(workRoot, { recursive: true });
  const store = await createStateStore({ workRoot, now, leaseTtlMs, heartbeatTimeoutMs });
  const lock = await acquireLock({ lockPath: await store.confinement.resolve('.roundtable/state/rtd.lock.d'), owner, now, ttlMs: lockTtlMs });
  if (!lock.acquired) return { status: 'locked', holder: lock.holder };
  store.setEpoch(lock.epoch); // fence every state write by the lock epoch (R4)

  // Set when a timed-out handler did not settle within graceMs: lock and issue lease stay renewed until it settles.
  let abandonedHandler = false;
  let finishPass;
  const passFinished = new Promise((resolve) => { finishPass = resolve; });
  // Lock-loss state is shared by the whole pass: queue reading, every wake and every handler.
  let lockLost = false;
  const abort = new AbortController();
  const markLost = () => { lockLost = true; abort.abort(new Error('single-flight lock lost')); };
  const refreshLock = async () => {
    if (!lockLost) {
      let ok = false;
      try { ok = await lock.refresh(); } catch { /* an unusable lock counts as lost */ }
      if (!ok) markLost();
    }
    return !lockLost;
  };
  // Renew the lock on an unref'd timer; the returned function stops it and waits for a renewal in flight.
  const startRenewal = () => {
    let renewing = null;
    const timer = setInterval(() => {
      if (renewing || lockLost) return;
      renewing = refreshLock().finally(() => { renewing = null; });
    }, Math.max(lockRenewMinMs, Math.floor(lockTtlMs / 3)));
    timer.unref();
    return async () => { clearInterval(timer); await renewing; };
  };

  try {
    let read;
    const stopRenewal = startRenewal();
    try {
      const queueAbort = new AbortController();
      const guard = withTimeout(queueTimeoutMs, () => queueAbort.abort(new Error('queue provider timed out')));
      try {
        read = await Promise.race([readQueue(queue, { confinement: store.confinement, signal: queueAbort.signal }), guard.timeout.then(() => {
          throw Object.assign(new Error(`queue provider did not settle within ${queueTimeoutMs} ms`), { code: 'RT_QUEUE_TIMEOUT' });
        })]);
      } finally { guard.clear(); }
    } finally {
      await stopRenewal();
    }
    const { items, skipped } = read;
    // Lost while the queue was read: another pass may own the state now, so do not start any wake.
    if (lockLost || !(await refreshLock())) return { status: 'lock_lost', outcomes: [], skipped };
    const outcomes = [];
    if (githubClient) {
      const manager = await createWorktreeManager({ workRoot, repoRoot, baseBranch, now });
      const coordinator = createClaimCoordinator({
        client: githubClient, stateRoot: await store.confinement.resolve('locks'),
        loadState: (id) => store.load(id), isStale: async (state) => store.staleness(state).stale,
        // The scheduler already holds the issue lock. Existing worktrees prevent new claims,
        // but a stale claimed issue must reuse its durable worktree.
        isInFlight: async (issue) => !(issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'rt:running') && (await manager.inspect(issue.id)).liveWorktree,
        resume: async (issue, state) => {
          if (!state.claimPending) return;
          const comments = typeof githubClient.listComments === 'function' ? await githubClient.listComments(issue.number ?? issue.id) : issue.comments ?? [];
          if (!comments.some((comment) => String(comment.body ?? comment).includes(CLAIM_MARKER))) {
            await githubClient.createComment(issue.number ?? issue.id, `${CLAIM_MARKER}\nClaimed by the roundtable loop (worker slot 1).`);
          }
          await store.update(issue.id, (current) => { current.claimPending = false; });
        },
        beforeClaim: async (issue) => { await store.update(issue.id, (state) => { state.claimPending = true; }); },
        afterClaim: async (issue) => { await store.update(issue.id, (state) => { state.claimPending = false; }); },
        canResume: (state) => state.status === 'working' || (['queued', 'waiting_external'].includes(state.status) && (state.claimPending === true || state.attempts.wakes > 0)), now,
      });
      const stopSchedulingRenewal = startRenewal();
      let scheduled;
      try { scheduled = await runWorkers({ issues: items, workRoot, workers, worktreeManager: manager, now,
        shouldStop: () => lockLost || abandonedHandler,
        prepare: async (item) => {
          if (lockLost || abandonedHandler || !(await refreshLock())) return false;
          const state = await store.load(item.id);
          if (isTerminal(state.status)) { skipped.push({ id: item.id, reason: 'terminal' }); return false; }
          const claim = await coordinator.tick([item]);
          if (!claim.claimed && !claim.resumed) { skipped.push(...claim.skipped); return false; }
          return true;
        },
        run: async (item, worker) => {
          worker.signal.addEventListener('abort', markLost, { once: true });
          try { outcomes.push(await wakeGuarded({ ...item, worktree: worker.worktree })); }
          finally { worker.signal.removeEventListener('abort', markLost); }
        },
      });
      } finally { await stopSchedulingRenewal(); }
      skipped.push(...scheduled.skipped);
      if (lockLost) return { status: 'lock_lost', outcomes, skipped, ...(abandonedHandler ? { abandonedHandler: true } : {}) };
      if (scheduled.failed.length) throw scheduled.failed[0].error;
    } else {
      for (const item of items) {
        const outcome = await wakeGuarded(item);
        outcomes.push(outcome);
        if (outcome.status === 'lock_lost') return { status: 'lock_lost', outcomes, skipped, ...(abandonedHandler ? { abandonedHandler: true } : {}) };
        if (abandonedHandler) break;
      }
    }
    return { status: 'ok', outcomes, skipped, ...(abandonedHandler ? { abandonedHandler: true } : {}) };
  } catch (err) {
    if (abandonedHandler && err !== null && typeof err === 'object') err.abandonedHandler = true;
    throw err;
  } finally {
    // release() reports false (never throws on a lost lock) when the epoch file is no longer ours; the
    // lease then simply expires. A failing release must not mask the pass result. An abandoned handler
    // retains the lock until it settles.
    if (!abandonedHandler) await lock.release().catch(() => false);
    finishPass();
  }

  // One issue with a corrupt state file must not abort the pass (R5): its outcome is `failed` / `corrupt_state`
  // and the file is left byte for byte. A write refused by the epoch fence means a successor owns the state:
  // that is a lost lock.
  async function wakeGuarded(item) {
    try {
      return await wake(item);
    } catch (err) {
      if (err instanceof StaleEpochError) {
        markLost();
        return { id: item.id, status: 'lock_lost', reason: 'lock_lost', decision: 'wait' };
      }
      if (err instanceof CorruptStateError) return { id: item.id, status: 'failed', reason: 'corrupt_state', decision: 'ask', detail: err.message };
      throw err; // other failures (e.g. a write error such as ENOSPC) still abort the pass: the lock is released
    }
  }

  async function wake(item) {
    const id = item.id;
    const out = (status, extra = {}) => ({ id, status, ...extra });
    const lost = () => out('lock_lost', { reason: 'lock_lost', decision: 'wait' });

    // First step, before `store.recover` or any other write: a lock lost since the last check (also in the
    // gap between two issues) must not let this process touch state its successor may own.
    if (!(await refreshLock())) return lost();

    const recovery = await store.recover(id);
    if (recovery.action === 'held') return out('held', { owner: recovery.owner });
    if (recovery.action === 'interrupted') return out('interrupted', { phase: recovery.resumePhase });
    let state = await store.load(id);
    if (isTerminal(state.status)) return out(state.status, { skipped: true });

    if (state.attempts.wakes >= maxWakesPerIssue) {
      await store.update(id, (s) => { s.status = 'stop'; s.lastEvent = { type: 'wake_budget_exhausted', at: now() }; });
      return out('stop', { reason: 'wake_budget_exhausted', decision: 'stop' });
    }
    const lease = await store.acquireLease(id, owner);
    if (!lease.acquired) return out('held', { owner: lease.state.lease.owner });
    await store.bump(id, 'wakes');

    const finish = (status, cls, reason, decision) =>
      store.update(id, (s) => { s.status = status; s.lastEvent = { type: cls, at: now(), ...(reason ? { detail: reason } : {}) }; })
        .then(() => out(status, { class: cls, reason, decision }));

    try {
      let phase = PHASES[PHASES.indexOf(state.checkpoint?.phase ?? null) + 1] ?? PHASES[0];
      // retryDeveloper persists the counter before the stop status. A crash between those writes
      // must not start another developer attempt, while later checkpointed phases may still resume.
      if (phase === 'developing' && state.attempts.developer >= maxDeveloperAttempts) {
        return await finish('stop', 'developer_budget_exhausted', 'developer_budget_exhausted', 'stop');
      }
      for (;;) {
        // After a lost lock nothing is written for this issue: not even beginPhase (the wake's first step and
        // the check after each handler already ran a real refresh, this only reads the shared flag).
        if (lockLost) return lost();
        await store.beginPhase(id, phase);
        if (!(await refreshLock())) return lost();
        state = await store.load(id);
        // Closed when the race between the handler and its timeout ends: a handler that is still running (it only
        // got a signal) can no longer write anything for this issue.
        let closed = false;
        const heartbeat = async () => {
          if (closed) throw new Error('phase closed');
          if (lockLost) throw new Error('single-flight lock lost');
          await store.heartbeat(id, owner);
          if (!(await refreshLock())) throw new Error('single-flight lock lost');
        };
        const recordArtifacts = async (artifacts) => {
          if (closed) throw new Error('phase closed');
          if (lockLost) throw new Error('single-flight lock lost');
          return store.recordArtifacts(id, artifacts);
        };

        // Renew the lock while the handler runs, so a quiet handler never lets the lease expire.
        const stopRenewal = startRenewal();
        let leaseRenewal = null;
        const leaseTimer = setInterval(() => {
          if (!leaseRenewal && !lockLost) {
            leaseRenewal = store.heartbeat(id, owner).catch(() => {}).finally(() => { leaseRenewal = null; });
          }
        }, Math.max(1, Math.floor(leaseTtlMs / 3)));
        leaseTimer.unref();
        const stopPhaseRenewal = async () => {
          clearInterval(leaseTimer);
          await leaseRenewal;
          await stopRenewal();
        };

        let step;
        let phaseTimedOut = false;
        let running;
        const phaseAbort = new AbortController();
        const signal = AbortSignal.any([abort.signal, phaseAbort.signal]);
        const guard = withTimeout(phaseTimeoutMs, () => phaseAbort.abort(new Error('phase timed out')));
        try {
          running = Promise.resolve().then(() => handler({ item, phase, stage: STAGE[phase], state, heartbeat, recordArtifacts, signal }));
          running.catch(() => {}); // a handler that settles after its timeout must not become an unhandled rejection
          const returned = await Promise.race([running, guard.timeout.then(() => TIMED_OUT)]);
          phaseTimedOut = returned === TIMED_OUT;
          step = phaseTimedOut
            ? { exitCode: null, timedOut: true, output: `handler did not settle within ${phaseTimeoutMs} ms` }
            // Anything but a plain object (undefined, null, a primitive, an array) is a failed result, never success.
            : returned !== null && typeof returned === 'object' && !Array.isArray(returned)
              ? { ...returned }
              : { exitCode: null, output: 'handler returned no result' };
        } catch (err) {
          // A path escape from the handler's own recordArtifacts() is a scope problem, not a developer failure.
          step = err instanceof PathEscapeError
            ? { scopeMismatch: true, output: `handler error: ${err.message}` }
            : { exitCode: 1, output: `handler error: ${err?.message ?? err}` };
        } finally {
          closed = true;
          guard.clear();
          // The abandoned handler gets a bounded grace period to settle before anything else happens (the lease is
          // released after this, and no retry starts in this wake); the lock stays renewed meanwhile.
          // If it still has not settled, retain renewal until the handler actually ends.
          if (phaseTimedOut && !(await settleWithin(running, graceMs))) {
            abandonedHandler = true;
            // Keep ownership until both the handler and the pass have finished writing state.
            void running.then(() => {}, () => {}).then(async () => {
              await passFinished;
              await stopPhaseRenewal();
              if (!lockLost) await store.releaseLease(id, owner).catch(() => {});
              await lock.release().catch(() => false);
            });
          } else await stopPhaseRenewal();
        }
        if (lockLost || !(await refreshLock())) return lost();
        try {
          await store.recordArtifacts(id, step.artifacts);
        } catch (err) {
          if (!(err instanceof PathEscapeError)) throw err;
          step.scopeMismatch = true;
        }

        const verdict = classify({ ...step, stage: STAGE[phase] });
        const { class: cls, reason } = verdict;

        if (cls === 'ok' || cls === 'review_passed') {
          await store.checkpoint(id, phase, { changedFiles: step.changedFiles });
          if (phase === 'finalizing') return await finish('done', cls, undefined, 'done');
          phase = PHASES[PHASES.indexOf(phase) + 1];
        } else if (verdict.consumesDeveloperRetry) {
          // One durable write: counter, checkpoint reset and event, so a crash cannot split them.
          // After a phase timeout the abandoned handler may still be running: never start the retry in this wake.
          const next = await store.retryDeveloper(id, cls, reason, phaseTimedOut ? { suspendPhase: phase } : undefined);
          if (next.attempts.developer >= maxDeveloperAttempts) return await finish('stop', cls, 'developer_budget_exhausted', 'stop');
          if (phaseTimedOut) return out('queued', { class: cls, reason, decision: 'wait', phase: PHASES[0] });
          phase = PHASES[0];
        } else if (cls === 'finalize_failure') {
          // Finalizing may already have had external side effects: never re-run it automatically.
          await store.markInterrupted(id, phase, cls);
          return out('interrupted', { class: cls, reason, decision: 'ask', phase });
        } else if (cls === 'reviewer_unavailable') {
          const next = await store.bump(id, 'reviewerUnavailable');
          if (next.attempts.reviewerUnavailable >= maxReviewerUnavailable) return await finish('stop', cls, 'reviewer_unavailable_budget_exhausted', 'stop');
          return await finish('waiting_external', cls, reason, 'wait');
        } else if (cls === 'human_block') {
          return await finish('waiting_person', cls, reason, 'ask');
        } else {
          return await finish('out-of-scope', cls, reason, 'ask');
        }
      }
    } finally {
      // After a lost lock another process owns the state: write nothing. Our lease simply expires. The same goes
      // for an abandoned handler: its renewal continues until the handler settles.
      if (!lockLost && !abandonedHandler) await store.releaseLease(id, owner).catch((err) => { if (err instanceof StaleEpochError) markLost(); });
    }
  }
}

const TIMED_OUT = Symbol('timed out');

/** Wait until `promise` settles (either way) or `ms` passed, whichever comes first; the delay timer is always cleared. Resolves true when it settled. */
async function settleWithin(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true, () => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); })]);
  } finally { clearTimeout(timer); }
}

/** `timeout` resolves after `ms` (never when `ms` is Infinity); `clear()` cancels the timer. Runs `onTimeout` when it fires. */
function withTimeout(ms, onTimeout) {
  let timer;
  const timeout = new Promise((resolve) => {
    if (ms === Infinity) return;
    // Deliberately not unref'd: a never-settling handler or queue provider must still end with the timeout recorded.
    timer = setTimeout(() => { onTimeout(); resolve(); }, Math.min(ms, 2 ** 31 - 1));
  });
  return { timeout, clear: () => clearTimeout(timer) };
}

async function main(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, options: { 'work-root': { type: 'string' }, queue: { type: 'string' }, github: { type: 'boolean' }, repo: { type: 'string' }, handler: { type: 'string' }, 'repo-root': { type: 'string' }, workers: { type: 'string' }, 'phase-timeout-ms': { type: 'string' }, 'queue-timeout-ms': { type: 'string' }, 'grace-ms': { type: 'string' } } }).values;
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (!args['work-root'] || !args.handler || Boolean(args.queue) === Boolean(args.github) || (args.repo && !args.github)) {
    console.error('usage: rtd.mjs --work-root DIR (--queue FILE | --github [--repo OWNER/REPO] [--repo-root DIR] [--workers N]) --handler MODULE [--phase-timeout-ms N] [--queue-timeout-ms N] [--grace-ms N] (MODULE is trusted operator code, not confined to the work root)');
    return 2;
  }
  const timeouts = {};
  for (const [flag, option] of [['phase-timeout-ms', 'phaseTimeoutMs'], ['queue-timeout-ms', 'queueTimeoutMs'], ['grace-ms', 'graceMs']]) {
    if (args[flag] === undefined) continue;
    const n = Number(args[flag]);
    if (!/^\d+$/.test(args[flag]) || !Number.isSafeInteger(n) || (option !== 'graceMs' && n === 0)) {
      console.error(`--${flag} must be a ${option === 'graceMs' ? 'non-negative' : 'positive'} integer (milliseconds)`);
      return 2;
    }
    timeouts[option] = n;
  }
  const { default: handler } = await import(pathToFileURL(resolve(args.handler)).href);
  const queue = args.github ? createIntakeProvider(createGitHubReader({ repo: args.repo }), { includeRunning: true }) : args.queue;
  const result = await runQueue({ workRoot: args['work-root'], queue, handler, ...timeouts, ...(args.github ? { githubClient: createGitHubWriter({ repo: args.repo }), repoRoot: resolve(args['repo-root'] ?? '.'), workers: args.workers === undefined ? 2 : Number(args.workers) } : {}) });
  if (args.github) result.triage = queue.triage;
  const code = exitCodeFor(result);
  if (result.abandonedHandler) {
    // A handler that never settled may still be running and would keep this process alive past the lock's
    // expiry: end the process (after stdout is flushed) so it cannot outlive this run.
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(code));
    return new Promise(() => {});
  }
  console.log(JSON.stringify(result));
  return code;
}

const invoked = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
  console.error(err);
  if (err?.abandonedHandler) process.exit(1);
  process.exitCode = 1;
});
