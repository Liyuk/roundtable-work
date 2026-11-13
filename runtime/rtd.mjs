#!/usr/bin/env node
import { mkdir, readFile } from 'node:fs/promises';
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
import { applyDecision, resumeAfterOwnerReply } from './lib/decisions.mjs';
import { runGates, recoverRedMain } from './lib/gates.mjs';
import { createProductionAdapter } from './lib/production.mjs';
import { createMergeEntryPoint } from './lib/merge.mjs';
import { observeAndCheckTransition } from './lib/observe.mjs';
import { runStatus, RUNTIME_DEFAULTS } from './lib/status.mjs';
import { loadRouting, routingFacts, renderRolePrompt, RoutingError } from './lib/routing.mjs';

const STAGE = { developing: 'developer', testing: 'test', reviewing: 'reviewer', finalizing: 'finalize' };
/** Passes after which an unresolved pre-merge marker is reported even when it is younger than `mergeUnknownTimeoutMs`. */
const MERGE_UNKNOWN_MAX_ATTEMPTS = 3;
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
 * `handler({ item, phase, stage, state, heartbeat, recordArtifacts, signal, routing })` performs one phase and returns
 * `{ exitCode, timedOut, output, scopeMismatch, humanBlock, artifacts, changedFiles }`.
 * CLI routing supplies `facts.roles` (harness, model, tier) and rendered `prompts` to the trusted handler.
 * It must not delete worktree / diff / output artifacts; it reports their paths (returned or via
 * `recordArtifacts`, which persists them immediately so a crash cannot lose the record).
 * For auto-merge, `autoMerge.context({ item, state, result, signal })` supplies the PR number, head, tree,
 * boolean highRisk and changedFiles. `autoMerge.gates` and `autoMerge.github` provide injected gate and
 * GitHub operations; `autoMerge.github.getPullRequest` must return { state, draft, head, mergeable, files },
 * where files is the pull request's changed paths (the merge entry point re-derives the safety-file set
 * from it and fails closed when it is missing), and `state: 'merged'`/`merged: true` plus an optional
 * `mergeCommit` SHA lets the monitor resolve a merge whose outcome was unknown. Gate records are persisted in the issue state; the merge
 * entry point rechecks the PR and CI. GitHub intake requires `--providers MODULE`, a trusted module exporting the production providers.
 * For a file queue, the trusted handler module may export `observationClients`; missing clients fail closed.
 *
 * A `stage:'merging'` record is written immediately before the squash (`pr`, `head`, `tree`, `since`) and replaced
 * by `{ stage:'monitoring', mergeCommit }` after success. A later pass resolves a leftover marker from the live
 * pull request instead of pausing forever: open or closed-unmerged clears the hold, merged continues into
 * monitoring, and an outcome that stays unknown past `mergeUnknownTimeoutMs` (default 15 min) or
 * `MERGE_UNKNOWN_MAX_ATTEMPTS` passes is reported once through `github.createIssue` while the hold stays. An
 * operator clears a hold with `rtd.mjs --work-root DIR --providers MODULE --clear-main-pause` (`clearMainPause`).
 *
 * A failed or timed-out `finalizing` step ends the wake as `interrupted` (decision `ask`, class
 * `finalize_failure`, `recovery.resumePhase = 'finalizing'`): it is not retried from development and
 * spends no developer retry. A `PathEscapeError` thrown by the handler's own `recordArtifacts()` is a
 * scope mismatch (`out-of-scope`), not a developer failure. A gate *hold* in the finalizing auto-merge
 * step (nothing merged: pending CI, missing recorded safety approval, reviewer unavailable, or a
 * transient gate/CI error) is not terminal: the wake ends as `waiting_external` (decision `wait`, class
 * `finalize_hold`) with `recovery` untouched and the persisted gate record kept, so a later wake resumes
 * at `finalizing` and reuses the gates that already passed.
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
 * CLI: `rtd.mjs --work-root DIR --queue FILE --handler MODULE --routing FILE [--phase-timeout-ms N] [--queue-timeout-ms N] [--grace-ms N]`. `--handler` is trusted operator code,
 * deliberately outside work-root confinement (only paths under the work root are confined).
 * `rtd.mjs --work-root DIR --providers MODULE --clear-main-pause` clears a stale main hold (see `clearMainPause`).
 *
 * @returns {Promise<{status:'locked', holder:object} | {status:'lock_lost', outcomes:object[], skipped:object[], abandonedHandler?:true} | {status:'ok', outcomes:object[], skipped:object[], abandonedHandler?:true}>}
 */
export async function runQueue({
  workRoot, queue, handler, now = Date.now, owner = `rtd-${process.pid}-${randomUUID()}`,
  leaseTtlMs = 60_000, heartbeatTimeoutMs = RUNTIME_DEFAULTS.heartbeatTimeoutMs, lockTtlMs = 5 * 60_000, lockRenewMinMs = 1000,
  maxWakesPerIssue = RUNTIME_DEFAULTS.maxWakesPerIssue, maxDeveloperAttempts = RUNTIME_DEFAULTS.maxDeveloperAttempts, maxReviewerUnavailable = RUNTIME_DEFAULTS.maxReviewerUnavailable,
  phaseTimeoutMs = 60 * 60_000, queueTimeoutMs = 10 * 60_000, graceMs = 5000,
  mergeUnknownTimeoutMs = 15 * 60_000,
  githubClient, repoRoot, workers = 2, baseBranch = 'main', autoMerge, observationClients, models = {}, routing,
}) {
  if (typeof handler !== 'function') throw new TypeError('handler must be a function');
  observationClients ??= autoMerge?.observationClients;
  if ((autoMerge?.production || githubClient) && !observationClients) throw new TypeError('production observation clients are required');
  if (githubClient && !repoRoot) throw new TypeError('repoRoot is required for tracker workers');
  // The lock must be renewed well before it expires: at least two renewals fit into one lease.
  for (const [name, value] of [['lockTtlMs', lockTtlMs], ['lockRenewMinMs', lockRenewMinMs], ['leaseTtlMs', leaseTtlMs]]) {
    if (!(typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new TypeError(`${name} must be a positive number`);
  }
  for (const [name, value] of [['phaseTimeoutMs', phaseTimeoutMs], ['queueTimeoutMs', queueTimeoutMs]]) {
    if (!(typeof value === 'number' && value > 0)) throw new TypeError(`${name} must be a positive number (Infinity disables it)`);
  }
  if (!(typeof graceMs === 'number' && Number.isFinite(graceMs) && graceMs >= 0)) throw new TypeError('graceMs must be a non-negative number');
  if (!(typeof mergeUnknownTimeoutMs === 'number' && Number.isFinite(mergeUnknownTimeoutMs) && mergeUnknownTimeoutMs > 0)) throw new TypeError('mergeUnknownTimeoutMs must be a positive number');
  if (lockRenewMinMs > lockTtlMs / 2) throw new TypeError(`lockRenewMinMs (${lockRenewMinMs}) must be <= lockTtlMs / 2 (${lockTtlMs / 2}), otherwise the lock can expire before its first renewal`);
  await mkdir(workRoot, { recursive: true });
  const store = await createStateStore({ workRoot, now, leaseTtlMs, heartbeatTimeoutMs });
  const lock = await acquireLock({ lockPath: await store.confinement.resolve('.roundtable/state/rtd.lock.d'), repoRoot: workRoot, owner, now, ttlMs: lockTtlMs });
  if (!lock.acquired) return { status: 'locked', holder: lock.holder };
  store.setEpoch(lock.epoch); // fence every state write by the lock epoch (R4)
  store.setFence({ highWater: () => lock.anchorHighWater() }); // and by the anchor high-water mark, not the state file

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

  // Serialize claim admission and merge/recovery decisions within this lock epoch.
  let admissionTail = Promise.resolve();
  const exclusive = async (fn) => {
    const previous = admissionTail;
    let release;
    admissionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  };
  const monitorId = 'rt-main-monitor';
  const readMonitor = async () => (await store.load(monitorId)).mainMonitor ?? (autoMerge?.pause ? await autoMerge.pause.get({ epoch: lock.epoch }) : null);
  const writeMonitor = async (value) => {
    // Keep the built-in hold even if a later pass omits the optional injected backend.
    if (value === null && autoMerge?.pause) await autoMerge.pause.put(null, { epoch: lock.epoch });
    await store.update(monitorId, (s) => { s.mainMonitor = value; });
    if (value !== null && autoMerge?.pause) await autoMerge.pause.put(value, { epoch: lock.epoch });
  };
  const gateStore = {
    get: async (issue) => (await store.load(issue)).gateRecord,
    put: async (issue, record) => { await store.update(issue, (s) => { s.gateRecord = record; }); },
  };
  const validContext = (context) => context && typeof context.highRisk === 'boolean' && Array.isArray(context.changedFiles) && context.changedFiles.every((f) => typeof f === 'string') && context.pr != null;
  const ensureLive = async (signal = abort.signal) => { if (signal.aborted || !(await refreshLock()) || signal.aborted) throw new Error('phase aborted or lock lost'); };
  const monitorMain = async (signal = abort.signal) => {
    const record = await readMonitor();
    if (!record) return false;
    if (record.stage === 'merging') return resolveUnknownMerge(record, signal);
    return monitorMerged(record, signal);
  };

  /**
   * Resolve a `stage:'merging'` marker from the live pull request. The marker is published immediately before
   * the squash, so a transient `squashMerge` error or a crash before the post-merge write leaves an unknown
   * outcome: resolve it instead of pausing every claim and merge until somebody edits state by hand.
   */
  const resolveUnknownMerge = async (record, signal) => {
    await ensureLive(signal);
    if (!Number.isSafeInteger(record.pr) || record.pr < 1) {
      // A legacy marker names no pull request: it cannot be resolved, so it must be reported, not ignored.
      return await escalateUnknownMerge(record, 'the pre-merge marker carries no pull request number', signal);
    }
    let live;
    try {
      live = await autoMerge.github.getPullRequest(record.pr);
      if (!live || typeof live !== 'object' || Array.isArray(live)) throw new Error('getPullRequest returned a malformed result');
    } catch (err) {
      return await retainUnknownMerge(record, `pull request #${record.pr} could not be read: ${err?.message ?? err}`, signal);
    }
    if (!(live.state === 'merged' || live.merged === true)) {
      if (!['open', 'closed'].includes(live.state)) {
        return await retainUnknownMerge(record, `pull request #${record.pr} has an unrecognized or malformed state`, signal);
      }
      // Still open, or closed without a merge: the squash did not land. Clearing is safe because the merge entry
      // point revalidates every gate and the live pull request immediately before any retry.
      await ensureLive(signal);
      await writeMonitor(null);
      return false;
    }
    if (typeof live.mergeCommit === 'string' && /^[0-9a-f]{7,40}$/i.test(live.mergeCommit)) {
      // The merge landed: continue as if the post-merge write had happened, so a red main still reverts.
      await ensureLive(signal);
      const next = { stage: 'monitoring', mergeCommit: live.mergeCommit };
      await writeMonitor(next);
      return await monitorMerged(next, signal);
    }
    let status;
    try { status = await autoMerge.github.mainStatus(); } catch (err) {
      return await retainUnknownMerge(record, `pull request #${record.pr} is merged but main status is unavailable: ${err?.message ?? err}`, signal);
    }
    if (!status || !['green', 'red', 'pending'].includes(status.status) || typeof status.head !== 'string' || !status.head) {
      return await retainUnknownMerge(record, `pull request #${record.pr} is merged but main status is malformed`, signal);
    }
    if (status.status === 'green') {
      // Merged, no usable merge commit, main green: there is nothing to revert, so the hold can go.
      await ensureLive(signal);
      await writeMonitor(null);
      return false;
    }
    return await escalateUnknownMerge(record, `pull request #${record.pr} is merged but the provider returned no merge commit and main is ${status.status}`, signal);
  };

  /**
   * Keep the hold for one more pass and count the failure in the marker. Escalation happens once a bounded age
   * (or a small attempt count) is reached; an already reported outcome never escalates again.
   */
  const retainUnknownMerge = async (record, reason, signal) => {
    await ensureLive(signal);
    const since = Number.isFinite(record.since) ? record.since : now();
    const attempts = (Number.isSafeInteger(record.attempts) && record.attempts > 0 ? record.attempts : 0) + 1;
    const reported = record.escalation?.inFlight === true || record.escalation?.done === true;
    const next = { ...record, since, attempts, lastError: reason };
    await writeMonitor(next);
    if (reported || !(now() - since >= mergeUnknownTimeoutMs || attempts >= MERGE_UNKNOWN_MAX_ATTEMPTS)) return true;
    return await escalateUnknownMerge(next, reason, signal);
  };

  /**
   * Report an unresolved merge outcome exactly once. The in-flight marker is persisted before the effect, so a
   * crash between the two writes leaves an explicit hold instead of creating a second issue on the next pass
   * (the same discipline `once()` uses for recovery effects). Only labels that exist in the repository are used.
   */
  const escalateUnknownMerge = async (record, reason, signal) => {
    const current = (await readMonitor()) ?? record;
    if (current.escalation?.inFlight === true || current.escalation?.done === true) return true; // already reported
    await ensureLive(signal);
    const pr = Number.isSafeInteger(current.pr) && current.pr > 0 ? current.pr : null;
    await writeMonitor({ ...current, escalation: { inFlight: true, at: now(), reason } });
    // A stale epoch must not perform an effect whose hold a successor already clears, so re-check liveness
    // after persisting the in-flight marker: the marker stays durable, the effect waits for a live lock.
    await ensureLive(signal);
    const created = await autoMerge.github.createIssue({
      title: `Manual merge-outcome check required for ${pr === null ? 'the auto-merge monitor' : `pull request #${pr}`}`,
      labels: ['type:bug', 'rt:self'],
      // Policy: never echo provider/error text, host paths, or URLs into an issue. The diagnostic stays in
      // the durable marker (`lastError`); only fixed category text, the PR number, the gated head/tree and the
      // recovery command are published.
      body: 'The auto-merge monitor found a pre-merge marker whose squash outcome could not be resolved automatically: '
        + 'the pull request was unreadable or malformed, the main branch status was unavailable or inconsistent, '
        + 'or a legacy marker had no pull request number. '
        + 'Claims and merges stay paused until the outcome is checked by hand. '
        + `Pull request: ${pr === null ? 'unknown (legacy marker)' : `#${pr}`}; gated head: ${current.head ?? 'unknown'}; tree: ${current.tree ?? 'unknown'}. `
        + 'After checking the pull request and main, clear the hold with `rtd.mjs --work-root DIR --providers MODULE --clear-main-pause`.',
    });
    await ensureLive(signal);
    await writeMonitor({ ...current, escalation: { done: true, at: now(), reason, issue: Number.isSafeInteger(created?.number) ? created.number : null } });
    return true;
  };

  // Post-merge monitoring: green main (after any revert) clears the hold; a red main at the merge commit drives
  // the revert path; anything else keeps the hold.
  const monitorMerged = async (initial, signal) => {
    let record = initial;
    await ensureLive(signal);
    const status = await autoMerge.github.mainStatus();
    if (!status || !['green', 'red', 'pending'].includes(status.status) || typeof status.head !== 'string' || !status.head) throw new Error('provider github.mainStatus returned an invalid status');
    // Publish an in-flight marker before every external recovery effect. A crash or error leaves
    // an explicit hold rather than repeating an action whose outcome is unknown.
    const once = async (key, effect) => {
      record = await readMonitor();
      const step = record.recovery?.[key];
      if (step?.done) return step.value;
      if (step?.inFlight) throw Object.assign(new Error(`Recovery ${key} outcome is unknown; main remains paused`), { code: 'RT_RECOVERY_UNKNOWN', recoveryStep: key });
      record.recovery ??= {};
      record.recovery[key] = { inFlight: true };
      await writeMonitor(record);
      await ensureLive(signal);
      const value = await effect();
      if (value == null) throw new Error(`Recovery ${key} returned no result; main remains paused`);
      record = await readMonitor();
      record.recovery[key] = { done: true, value };
      await writeMonitor(record);
      return value;
    };
    const notifyUnknown = async (key, reason) => {
      record = await readMonitor();
      record.recovery ??= {};
      const legacy = record.recovery.intervention;
      // Older records have one notification; its reason identifies the associated effect.
      const legacyKey = /^Recovery (revert|pullRequest|issue|revertMerged) outcome is unknown;/.exec(legacy?.reason ?? '')?.[1];
      if (legacy && !legacyKey && !legacy.done) throw new Error('Recovery notification outcome is unknown; human intervention required to inspect the external issue before resuming');
      const intervention = record.recovery.interventions?.[key] ?? (legacyKey === key ? legacy : null);
      if (intervention && !intervention.done) throw new Error('Recovery notification outcome is unknown; human intervention required to inspect the external issue before resuming');
      if (intervention) return;
      record.recovery.interventions ??= {};
      record.recovery.interventions[key] = { inFlight: true, reason };
      await writeMonitor(record);
      await ensureLive(signal);
      let issue;
      try {
        issue = await autoMerge.github.createIssue({
          title: `Human intervention required: recovery outcome unknown for ${record.mergeCommit.slice(0, 7)}`,
          labels: ['type:bug', 'rt:self'],
          body: `Human intervention required: recovery step \`${key}\` for auto-merge ${record.mergeCommit} has an unknown outcome. Main remains paused; inspect the external effect before resuming recovery.`,
        });
        if (issue == null) throw new Error('issue returned no result');
      } catch (cause) {
        throw new Error('Recovery notification outcome is unknown; human intervention required to inspect the external issue before resuming', { cause });
      }
      record = await readMonitor();
      record.recovery.interventions[key] = { done: true, value: issue, reason };
      await writeMonitor(record);
    };
    try {
      // Unknown effects must be resolved before status-based exits can clear or hide the hold.
      const legacy = record.recovery?.intervention;
      const legacyKey = /^Recovery (revert|pullRequest|issue|revertMerged) outcome is unknown;/.exec(legacy?.reason ?? '')?.[1];
      if (legacy && !legacy.done && !legacyKey) {
        throw new Error('Recovery notification outcome is unknown; human intervention required to inspect the external issue before resuming');
      }
      const unknownSteps = ['revert', 'pullRequest', 'issue', 'revertMerged']
        .filter((key) => record.recovery?.[key]?.inFlight && !record.recovery[key].done);
      for (const key of unknownSteps) {
        const notification = record.recovery?.interventions?.[key] ?? (legacyKey === key ? legacy : null);
        if (!notification || notification.done) await notifyUnknown(key, `Recovery ${key} outcome is unknown; main remains paused`);
      }
      if ((legacy && !legacy.done) || Object.values(record.recovery?.interventions ?? {}).some((item) => !item.done)) throw new Error('Recovery notification outcome is unknown; human intervention required to inspect the external issue before resuming');
      if (unknownSteps.length) return true;
      if (status.status === 'green' && (!record.recovery || record.recovery.revertMerged?.done)) {
        await ensureLive(signal);
        await writeMonitor(null);
        return false;
      }
      if (status.status !== 'red' || status.head !== record.mergeCommit) return true;
      await recoverRedMain({ mergeCommit: record.mergeCommit, mainHead: status.head, mainRed: true,
      pause: { async claimsAndMerges() {} },
      git: { createRevert: (args) => once('revert', () => autoMerge.git.createRevert(args)) },
      github: {
        openRevertPullRequest: (args) => once('pullRequest', () => autoMerge.github.openRevertPullRequest(args)),
        createIssue: (args) => once('issue', () => autoMerge.github.createIssue(args)),
        requiredGreen: (...args) => autoMerge.github.requiredGreen(...args),
      },
      merge: { squash: async (pr) => {
        const current = await readMonitor();
        if (current.recovery?.revertMerged?.done) return current.recovery.revertMerged.value;
        const issue = current.recovery?.issue?.value?.number;
        if (!Number.isSafeInteger(issue) || issue < 1) throw new Error('Recovery issue number is required');
        const context = await autoMerge.context({ recovery: { pr, issue, mergeCommit: record.mergeCommit } });
        if (!validContext(context) || context.pr !== pr) throw new Error('Incomplete revert merge context');
        const mergeGithub = {
          getPullRequest: (...args) => autoMerge.github.getPullRequest(...args),
          requiredGreen: (...args) => autoMerge.github.requiredGreen(...args),
          squashMerge: (...args) => once('revertMerged', () => autoMerge.github.squashMerge(...args)),
        };
        const guardedGateStore = { ...gateStore, put: async (...args) => { await ensureLive(signal); return gateStore.put(...args); } };
        const squash = createMergeEntryPoint({ github: mergeGithub, gateState: guardedGateStore });
        const gated = await runGates({ ...context, issue: String(issue), gates: autoMerge.gates, ci: autoMerge.github, github: autoMerge.github, state: guardedGateStore, merge: { squash }, models, routing });
        if (gated.status !== 'merged') throw new Error(`Revert ${gated.gate}: ${gated.reason}`);
        return gated.result;
      } },
      });
    } catch (error) {
      if (error?.code !== 'RT_RECOVERY_UNKNOWN') throw error;
      await notifyUnknown(error.recoveryStep, error.message);
      return true;
    }
    return true;
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
    if (autoMerge?.production) {
      const stopMonitorRenewal = startRenewal();
      let paused;
      try { paused = await exclusive(monitorMain); } finally { await stopMonitorRenewal(); }
      if (paused) return { status: 'ok', outcomes, skipped: [...skipped, ...items.map((item) => ({ id: item.id, reason: 'main_paused' }))] };
    } else if (await readMonitor()) {
      return { status: 'ok', outcomes, skipped: [...skipped, ...items.map((item) => ({ id: item.id, reason: 'main_paused' }))] };
    }
    if (githubClient) {
      const manager = await createWorktreeManager({ workRoot, repoRoot, baseBranch, now });
      const coordinator = createClaimCoordinator({
        client: githubClient, stateRoot: await store.confinement.resolve('locks'),
        loadState: (id) => store.load(id), isStale: async (state) => store.staleness(state).stale,
        // The scheduler already holds the issue lock. Existing worktrees prevent new claims,
        // but a stale claimed issue must reuse its durable worktree.
        isInFlight: async (issue, state) => {
          const status = await manager.inspect(issue.id);
          const resumableWorktree = state.attempts.wakes > 0 && ['queued', 'waiting_person', 'out-of-scope'].includes(state.status);
          return !resumableWorktree && !(issue.labels ?? []).some((l) => (typeof l === 'string' ? l : l.name) === 'rt:running') && status.liveWorktree;
        },
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
      try { scheduled = await runWorkers({ issues: items, workRoot, repoRoot, workers, worktreeManager: manager, now,
        shouldStop: () => lockLost || abandonedHandler,
        prepare: async (item) => exclusive(async () => {
          if (await readMonitor()) { skipped.push({ id: item.id, reason: 'main_paused' }); return false; }
          if (lockLost || abandonedHandler || !(await refreshLock())) return false;
          let state = await store.load(item.id);
          if (state.pause && ['waiting_person', 'out-of-scope'].includes(state.status)) {
            const comments = typeof githubClient.listComments === 'function'
              ? await githubClient.listComments(item.number ?? item.id)
              : [];
            await resumeAfterOwnerReply({ issue: item, comments, store, client: githubClient, now });
            state = await store.load(item.id);
          }
          if (isTerminal(state.status)) { skipped.push({ id: item.id, reason: 'terminal' }); return false; }
          const claim = await coordinator.tick([item]);
          if (!claim.claimed && !claim.resumed) { skipped.push(...claim.skipped); return false; }
          return true;
        }),
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
        if (await readMonitor()) { skipped.push({ id: item.id, reason: 'main_paused' }); continue; }
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
        // The expected SHA is fixed per step: a later call cannot substitute its own head for the transition target.
        const checkObservation = async (item, phase, step) => {
          if (!observationClients) return { allowed: false, mismatches: [{ reason: 'observation_clients_missing' }] };
          let expectedSha = step?.expectedSha;
          if (typeof observationClients.expectedSha === 'function') {
            expectedSha ??= await observationClients.expectedSha({ item, phase, step, expectedSha });
          }
          return observeAndCheckTransition({ clients: observationClients, issue: item, expectedSha, phase });
        };
        const requireObservation = async (item, phase, step) => {
          const observation = await checkObservation(item, phase, step);
          if (!observation.allowed) {
            const reason = `observation_failed:${observation.mismatches.map((m) => m.reason).join(',')}`;
            await store.update(id, (s) => { s.status = 'waiting_external'; s.lastEvent = { type: 'observation_failed', at: now(), detail: reason }; });
            const error = new Error(reason);
            error.observation = observation;
            throw error;
          }
          return observation;
        };
        const guard = withTimeout(phaseTimeoutMs, () => phaseAbort.abort(new Error('phase timed out')));
        try {
          running = Promise.resolve().then(async () => {
            const result = await handler({ item, phase, stage: STAGE[phase], state, heartbeat, recordArtifacts, signal, routing });
            if (phase !== 'finalizing' || !autoMerge || (result?.decisionFile ?? result?.decision) !== undefined || classify({ ...result, stage: STAGE[phase] }).class !== 'ok') return result;
            const executeMerge = async () => {
              if (await readMonitor()) throw new Error('Main is paused');
              const context = await autoMerge.context({ item, state, result, signal });
              if (!validContext(context)) throw new Error('Incomplete merge context');
              // Whether the provider's squashMerge already resolved. Everything before it stays fail-closed;
              // everything after it is bookkeeping, and must never turn a real merge into a finalize failure.
              let mergeHappened = false;
              const gateState = {
                get: async (issue) => (await store.load(issue)).gateRecord,
                put: async (issue, record) => {
                  if (signal.aborted) throw new Error('phase aborted');
                  await store.update(issue, (s) => { s.gateRecord = record; });
                },
              };
              const mergeGithub = {
                getPullRequest: (...args) => autoMerge.github.getPullRequest(...args),
                requiredGreen: (...args) => autoMerge.github.requiredGreen(...args),
                squashMerge: async (...args) => {
                  if (signal.aborted || !(await refreshLock()) || signal.aborted) throw new Error('phase aborted or lock lost');
                  // Self-describing pre-merge marker: a later pass resolves it from the live pull request when the
                  // squash errors out or this process dies before the post-merge write.
                  if (autoMerge.production) await writeMonitor({ stage: 'merging', pr: context.pr, head: context.head, tree: context.tree, since: now() });
                  const merged = await autoMerge.github.squashMerge(...args);
                  // Only after this point has main changed; the caller finishes the merge bookkeeping separately.
                  mergeHappened = true;
                  return merged;
                },
              };
              const squash = createMergeEntryPoint({ github: mergeGithub, gateState });
              const guardedSquash = async (...args) => {
                if (signal.aborted || !(await refreshLock())) throw new Error('phase aborted or lock lost');
                await requireObservation(item, phase, result);
                return squash(...args);
              };
              let gated;
              try {
                await requireObservation(item, 'pre-gates', result);
                gated = await runGates({ ...context, issue: id, gates: autoMerge.gates, ci: autoMerge.github, github: autoMerge.github, state: gateState, merge: { squash: guardedSquash }, models, routing });
              } catch (error) {
                if (error?.observation) return { ...result, mergeHold: { gate: 'observation', reason: error.message } };
                throw error;
              }
              if (gated.status !== 'merged') {
                // A hold merged nothing and has no side effect to repeat: hand it back to the wake loop so the
                // issue waits instead of failing closed. The passed gates are already persisted, so the next
                // wake resumes at finalizing and reuses them (only live CI and the safety approval are rechecked).
                if (gated.hold === true) return { ...result, mergeHold: { gate: gated.gate, reason: gated.reason } };
                // A genuine gate failure (an explicit not-pass verdict, or a merge entry point rejection such as
                // a stale head or a changed safety-file set) stays fail-closed: interrupted, decision ask.
                throw new Error(`${gated.gate}: ${gated.reason}`);
              }
              if (!mergeHappened) throw new Error('Merge entry point reported a merge without a provider squash result');
              // Post-merge bookkeeping. The squash already happened, so a failure here must not fail this wake:
              // the issue is delivered and the failure is kept as a non-fatal detail. Main protection is taken
              // from what was already written and is never weakened: an unusable mergeCommit leaves the
              // `{stage:'merging'}` record (main stays paused, no invented SHA), and a failed mainStatus leaves
              // `{stage:'monitoring', mergeCommit}`, so a later pass retries monitoring/recovery instead of
              // squashing the same pull request again.
              let mergeMonitorError;
              if (autoMerge.production) {
                try {
                  const mergeCommit = gated.result?.mergeCommit;
                  if (typeof mergeCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(mergeCommit)) throw new Error('provider github.squashMerge must return mergeCommit SHA; main remains paused');
                  await writeMonitor({ stage: 'monitoring', mergeCommit });
                  await monitorMain(signal);
                } catch (err) {
                  mergeMonitorError = `merge monitor: ${err?.message ?? err}`;
                }
              }
              // a merged step is never a hold, whatever the handler returned
              return { ...result, mergeHold: null, merged: true, ...(mergeMonitorError ? { mergeMonitorError } : {}) };
            };
            return autoMerge.production ? exclusive(executeMerge) : executeMerge();
          });
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

        // Checked before the ok/finalize_failure branches: a gate hold is neither success nor failure. Nothing
        // was merged (so main is not paused and no squash ran), the checkpoint still points at the last
        // completed phase (finalizing resumes), `recovery` is untouched, no developer retry is spent and the
        // persisted gateRecord survives for the next wake.
        if (phase === 'finalizing' && autoMerge && step.mergeHold) {
          return await finish('waiting_external', 'finalize_hold', `${step.mergeHold.gate}: ${step.mergeHold.reason}`, 'wait');
        }

        if (cls === 'ok' || cls === 'review_passed') {
          const decision = step.decisionFile ?? step.decision;
          if (phase === 'finalizing' && decision !== undefined) {
            if (!githubClient && typeof decision !== 'string' && !['do', 'continue'].includes(decision?.decision)) throw new TypeError('ask and out-of-scope decisions require the injected tracker client');
            const observation = await checkObservation(item, phase, step);
            if (!observation.allowed) {
              const reason = `observation_failed:${observation.mismatches.map((m) => m.reason).join(',')}`;
              await store.update(id, (s) => { s.status = 'waiting_external'; s.lastEvent = { type: 'observation_failed', at: now(), detail: reason }; });
              return out('waiting_external', { class: 'observation_failed', reason, decision: 'wait', observation });
            }
            const decisionResult = await applyDecision({ decision, issue: item, store, client: githubClient, now });
            return out(decisionResult.status, { class: 'decision', decision: decisionResult.decision });
          }
          if (!(phase === 'finalizing' && autoMerge && step.merged === true)) {
            const observation = await checkObservation(item, phase, step);
            if (!observation.allowed) {
              const reason = `observation_failed:${observation.mismatches.map((m) => m.reason).join(',')}`;
              await store.update(id, (s) => { s.status = 'waiting_external'; s.lastEvent = { type: 'observation_failed', at: now(), detail: reason }; });
              return out('waiting_external', { class: 'observation_failed', reason, decision: 'wait', observation });
            }
          }
          await store.checkpoint(id, phase, { changedFiles: step.changedFiles });
          // A post-merge monitor/bookkeeping failure is recorded as a detail, never as a failed wake.
          if (phase === 'finalizing') return await finish('done', cls, autoMerge ? step.mergeMonitorError : undefined, 'done');
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

/**
 * Operator recovery path: clear a stale main hold left by the auto-merge monitor (see `monitorMain`).
 *
 * Takes the same single-flight lock as a pass (`EXIT_LOCKED` / `{ status:'locked' }` when another pass holds it),
 * writes through the epoch-fenced state store, and clears both the persisted `mainMonitor` record and, when the
 * providers module exposes `pause`, the injected pause backend. A successful no-op when no hold exists.
 *
 * @returns {Promise<{status:'locked', holder:object} | {status:'ok', cleared:boolean}>}
 */
export async function clearMainPause({
  workRoot, providers = {}, now = Date.now, owner = `rtd-clear-${process.pid}-${randomUUID()}`, lockTtlMs = 5 * 60_000,
}) {
  if (!(typeof lockTtlMs === 'number' && Number.isFinite(lockTtlMs) && lockTtlMs > 0)) throw new TypeError('lockTtlMs must be a positive number');
  if (providers.pause !== undefined && (typeof providers.pause?.get !== 'function' || typeof providers.pause?.put !== 'function')) throw new TypeError('provider pause.get and pause.put are required');
  await mkdir(workRoot, { recursive: true });
  const store = await createStateStore({ workRoot, now });
  const lock = await acquireLock({ lockPath: await store.confinement.resolve('.roundtable/state/rtd.lock.d'), repoRoot: workRoot, owner, now, ttlMs: lockTtlMs });
  if (!lock.acquired) return { status: 'locked', holder: lock.holder };
  store.setEpoch(lock.epoch);
  store.setFence({ highWater: () => lock.anchorHighWater() });
  try {
    const previous = (await store.load('rt-main-monitor')).mainMonitor ?? (providers.pause ? await providers.pause.get({ epoch: lock.epoch }) : null);
    // Same order and shape as `writeMonitor(null)`: clear the pause backend first, then the fenced state record.
    if (providers.pause) await providers.pause.put(null, { epoch: lock.epoch });
    await store.update('rt-main-monitor', (s) => { s.mainMonitor = null; });
    return { status: 'ok', cleared: previous !== null && previous !== undefined };
  } finally {
    await lock.release().catch(() => false);
  }
}

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
  if (argv[0] === 'status') {
    const { output } = await runStatus({ argv: argv.slice(1) });
    console.log(output);
    return 0;
  }
  let args;
  try {
    args = parseArgs({ args: argv, options: { 'work-root': { type: 'string' }, queue: { type: 'string' }, github: { type: 'boolean' }, repo: { type: 'string' }, handler: { type: 'string' }, providers: { type: 'string' }, 'repo-root': { type: 'string' }, workers: { type: 'string' }, 'phase-timeout-ms': { type: 'string' }, 'queue-timeout-ms': { type: 'string' }, 'grace-ms': { type: 'string' }, 'clear-main-pause': { type: 'boolean' }, routing: { type: 'string' } } }).values;
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  if (args['clear-main-pause']) {
    // Operator recovery path: no handler and no queue are needed, only the work root and the providers module.
    if (!args['work-root'] || !args.providers) {
      console.error('usage: rtd.mjs --work-root DIR --providers MODULE --clear-main-pause');
      return 2;
    }
    const providers = (await import(pathToFileURL(resolve(args.providers)).href)).default ?? {};
    const result = await clearMainPause({ workRoot: args['work-root'], providers });
    console.log(JSON.stringify(result));
    return exitCodeFor(result);
  }
  if (!args['work-root'] || !args.handler || Boolean(args.queue) === Boolean(args.github) || (args.repo && !args.github)) {
    console.error('usage: rtd.mjs --work-root DIR (--queue FILE | --github [--repo OWNER/REPO] [--repo-root DIR] [--workers N]) --handler MODULE [--providers MODULE] --routing FILE [--phase-timeout-ms N] [--queue-timeout-ms N] [--grace-ms N] (MODULE is trusted operator code, not confined to the work root)');
    console.error('       rtd.mjs --work-root DIR --providers MODULE --clear-main-pause');
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
  if (!args.routing) {
    console.error('routing: --routing FILE is required');
    return 2;
  }
  let facts;
  try {
    facts = routingFacts(await loadRouting(args.routing), Date.now());
  } catch (error) {
    if (!(error instanceof RoutingError)) throw error;
    console.error(error.message.replace(/^routing /, 'routing: '));
    return 2;
  }
  const prompts = {};
  for (const role of ['chief', 'developer', 'fixer', 'reviewer', 'researcher']) {
    const prompt = await readFile(new URL(`../.agents/skills/roundtable-work/prompts/roles/${role}.md`, import.meta.url), 'utf8');
    prompts[role] = renderRolePrompt(prompt, facts);
  }
  const routing = { facts, prompts };
  const models = { reviewer: facts.roles.reviewer.model, crossCheck: facts.roles.crosscheck.model };
  const handlerModule = await import(pathToFileURL(resolve(args.handler)).href);
  const handler = handlerModule.default;
  const autoMerge = args.providers ? createProductionAdapter((await import(pathToFileURL(resolve(args.providers)).href)).default) : handlerModule.autoMerge;
  if (args.github && !args.providers) {
    console.error('GitHub workers require --providers MODULE with production gate, GitHub and git providers');
    return 2;
  }
  const queue = args.github ? createIntakeProvider(createGitHubReader({ repo: args.repo }), { includeRunning: true }) : args.queue;
  const result = await runQueue({ workRoot: args['work-root'], queue, handler, autoMerge, observationClients: autoMerge?.observationClients ?? handlerModule.observationClients, models, routing, ...timeouts, ...(args.github ? { githubClient: createGitHubWriter({ repo: args.repo }), repoRoot: resolve(args['repo-root'] ?? '.'), workers: args.workers === undefined ? 2 : Number(args.workers) } : {}) });
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
