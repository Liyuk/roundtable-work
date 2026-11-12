#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PathEscapeError } from './lib/paths.mjs';
import { acquireLock } from './lib/lock.mjs';
import { readQueue, isTerminal } from './lib/queue.mjs';
import { createStateStore, PHASES } from './lib/state.mjs';
import { classify } from './lib/classify.mjs';

const STAGE = { developing: 'developer', testing: 'test', reviewing: 'reviewer', finalizing: 'finalize' };
export const EXIT_LOCKED = 75;
export const EXIT_LOCK_LOST = 76;

/** Process exit code for a `runQueue` result: 0 ok, 75 locked (another pass is running), 76 lock lost (pass aborted). */
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
 * every phase, by every `heartbeat()` call, and automatically on an unref'd timer while a handler runs
 * (every `max(lockRenewMinMs, floor(lockTtlMs / 3))` ms, `lockRenewMinMs` defaults to 1000), so a quiet
 * handler keeps the lock and no other process can run the same queue meanwhile. `heartbeat()` stays
 * available as an extra liveness signal for the per-issue lease. When the lock is lost (a refresh fails
 * or throws) the `signal` passed to the handler is aborted and the wake is aborted once the handler
 * settles: no further handler runs, nothing more is recorded for the interrupted phase (the handler's
 * own `recordArtifacts()` / `heartbeat()` calls reject), the other process's lock is left alone,
 * per-issue state and artifacts are kept, and the issue lease is released only if it is still ours.
 * The pass then returns `{ status:'lock_lost', outcomes, skipped }` (outcomes holds finished issues
 * and the interrupted one with `status:'lock_lost'`). The CLI exits 0 for `ok`, 75 (`EXIT_LOCKED`) for
 * `locked` and 76 (`EXIT_LOCK_LOST`) for `lock_lost`, see `exitCodeFor()`.
 *
 * CLI: `rtd.mjs --work-root DIR --queue FILE --handler MODULE`. `--handler` is trusted operator code,
 * deliberately outside work-root confinement (only paths under the work root are confined).
 *
 * @returns {Promise<{status:'locked', holder:object} | {status:'lock_lost', outcomes:object[], skipped:object[]} | {status:'ok', outcomes:object[], skipped:object[]}>}
 */
export async function runQueue({
  workRoot, queue, handler, now = Date.now, owner = `rtd-${process.pid}`,
  leaseTtlMs = 60_000, heartbeatTimeoutMs = 120_000, lockTtlMs = 5 * 60_000, lockRenewMinMs = 1000,
  maxWakesPerIssue = 5, maxDeveloperAttempts = 3, maxReviewerUnavailable = 5,
}) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  await mkdir(workRoot, { recursive: true });
  const store = await createStateStore({ workRoot, now, leaseTtlMs, heartbeatTimeoutMs });
  const lock = await acquireLock({ lockPath: await store.confinement.resolve('rtd.lock'), owner, now, ttlMs: lockTtlMs });
  if (!lock.acquired) return { status: 'locked', holder: lock.holder };

  try {
    const { items, skipped } = await readQueue(queue, { confinement: store.confinement });
    const outcomes = [];
    for (const item of items) {
      const outcome = await wake(item);
      outcomes.push(outcome);
      if (outcome.status === 'lock_lost') return { status: 'lock_lost', outcomes, skipped };
    }
    return { status: 'ok', outcomes, skipped };
  } finally {
    await lock.release();
  }

  async function wake(item) {
    const id = item.id;
    const out = (status, extra = {}) => ({ id, status, ...extra });

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

    let lockLost = false;
    const abort = new AbortController();
    const refreshLock = async () => {
      if (!lockLost) {
        let ok = false;
        try { ok = await lock.refresh(); } catch { /* an unusable lock counts as lost */ }
        if (!ok) { lockLost = true; abort.abort(new Error('single-flight lock lost')); }
      }
      return !lockLost;
    };
    const lost = () => out('lock_lost', { reason: 'lock_lost', decision: 'wait' });

    try {
      let phase = PHASES[PHASES.indexOf(state.checkpoint?.phase ?? null) + 1] ?? PHASES[0];
      for (;;) {
        await store.beginPhase(id, phase);
        if (!(await refreshLock())) return lost();
        state = await store.load(id);
        const heartbeat = async () => {
          if (lockLost) throw new Error('single-flight lock lost');
          await store.heartbeat(id, owner);
          if (!(await refreshLock())) throw new Error('single-flight lock lost');
        };
        const recordArtifacts = async (artifacts) => {
          if (lockLost) throw new Error('single-flight lock lost');
          return store.recordArtifacts(id, artifacts);
        };

        // Renew the lock while the handler runs, so a quiet handler never lets the lease expire.
        let renewing = null;
        const timer = setInterval(() => {
          if (renewing || lockLost) return;
          renewing = refreshLock().finally(() => { renewing = null; });
        }, Math.max(lockRenewMinMs, Math.floor(lockTtlMs / 3)));
        timer.unref();

        let step;
        try {
          step = { ...(await handler({ item, phase, stage: STAGE[phase], state, heartbeat, recordArtifacts, signal: abort.signal })) };
        } catch (err) {
          // A path escape from the handler's own recordArtifacts() is a scope problem, not a developer failure.
          step = err instanceof PathEscapeError
            ? { scopeMismatch: true, output: `handler error: ${err.message}` }
            : { exitCode: 1, output: `handler error: ${err?.message ?? err}` };
        } finally {
          clearInterval(timer);
          await renewing;
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
          const next = await store.retryDeveloper(id, cls, reason);
          if (next.attempts.developer >= maxDeveloperAttempts) return await finish('stop', cls, 'developer_budget_exhausted', 'stop');
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
      await store.releaseLease(id, owner);
    }
  }
}

async function main(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, options: { 'work-root': { type: 'string' }, queue: { type: 'string' }, handler: { type: 'string' } } }).values;
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (!args['work-root'] || !args.queue || !args.handler) {
    console.error('usage: rtd.mjs --work-root DIR --queue FILE --handler MODULE (MODULE is trusted operator code, not confined to the work root)');
    return 2;
  }
  const { default: handler } = await import(pathToFileURL(resolve(args.handler)).href);
  const result = await runQueue({ workRoot: args['work-root'], queue: args.queue, handler });
  console.log(JSON.stringify(result));
  return exitCodeFor(result);
}

const invoked = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(err); process.exitCode = 1; });
