import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from './lock.mjs';
import { assertSafeId, createConfinement } from './paths.mjs';
import { dependencies as dependenciesFromBody } from './intake.mjs';
import { lockKeysOf, parseTouchSet } from './touch-set.mjs';

const seriesOf = (issue) => issue.series ?? /^\[([^\]]+)\]/.exec(issue.title ?? '')?.[1]?.toLowerCase() ?? null;
const depsOf = (issue) => new Set([...(issue.dependencies ?? issue.dependsOn ?? []), ...dependenciesFromBody(issue.body ?? '')].map(String));
function conflicts(a, b) {
  if (a.id === b.id) return true;
  const sa = seriesOf(a), sb = seriesOf(b);
  if (sa && sb && sa.toLowerCase() === sb.toLowerCase()) return true;
  if (depsOf(a).has(String(b.id)) || depsOf(b).has(String(a.id))) return true;
  const ta = parseTouchSet(a.body ?? ''), tb = parseTouchSet(b.body ?? '');
  // Same key set as the launch-time touch locks, so no two in-process runs ever contend for one lock key.
  return !ta || !tb || lockKeysOf(ta).some((key) => lockKeysOf(tb).includes(key));
}

/** Run eligible issues with cross-process per-issue locks and in-process series/dependency exclusion. */
export async function runWorkers({ issues, workRoot, repoRoot, workers = 2, run, now = Date.now, lockTtlMs = 60_000, worktreeManager, prepare = async () => true, shouldStop = () => false, onSkip = () => {} }) {
  if (!Array.isArray(issues) || typeof run !== 'function') throw new TypeError('issues and run are required');
  if (!Number.isSafeInteger(workers) || workers < 1) throw new TypeError('workers must be a positive integer');
  const confinement = await createConfinement(workRoot);
  const lockRoot = await confinement.resolve('locks');
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const pending = [...issues];
  const active = new Map();
  const completed = [], skipped = [], failed = [];
  const launch = (issue) => {
    const id = assertSafeId(issue.id ?? issue.number);
    const promise = (async () => {
      const lock = await acquireLock({ lockPath: join(lockRoot, `${id}.lock.d`), repoRoot: repoRoot ?? confinement.root, owner: `worker-${process.pid}-${id}`, now, ttlMs: lockTtlMs });
      if (!lock.acquired) {
        const item = { id, reason: 'issue_locked', holder: lock.holder };
        skipped.push(item); await onSkip(item); return;
      }
      const controller = new AbortController();
      let renewal = null, lockLost = false;
      const touchLocks = [];
      const timer = setInterval(() => {
        if (renewal || lockLost) return;
        renewal = Promise.all([lock, ...touchLocks].map((handle) => handle.refresh())).then((results) => {
          if (!results.every(Boolean)) { lockLost = true; controller.abort(new Error('issue lock lost')); }
        }, (error) => {
          lockLost = true;
          controller.abort(error);
        }).finally(() => { renewal = null; });
      }, Math.max(1, Math.floor(lockTtlMs / 3)));
      timer.unref();
      try {
        for (const key of lockKeysOf(parseTouchSet(issue.body ?? '') ?? [])) {
          const touch = await acquireLock({ lockPath: join(lockRoot, `touch-${createHash('sha256').update(key).digest('hex')}.lock.d`), repoRoot: repoRoot ?? confinement.root, owner: `worker-${process.pid}-${id}`, now, ttlMs: lockTtlMs });
          if (!touch.acquired) {
            const item = { id, reason: 'touch_set_locked', holder: touch.holder };
            skipped.push(item); await onSkip(item); return;
          }
          touchLocks.push(touch);
        }
        if (!(await prepare(issue))) return;
        const worktree = worktreeManager ? await worktreeManager.create(id) : undefined;
        await run(issue, { id, lock, workRoot: confinement.root, worktree: worktree?.path, existingWorktree: worktree?.existing ?? false, signal: controller.signal });
        if (lockLost) throw new Error('issue lock lost');
        completed.push(id);
      } finally {
        clearInterval(timer);
        await renewal;
        await Promise.all(touchLocks.map((touch) => touch.release().catch(() => false)));
        await lock.release().catch(() => false);
      }
    })().catch((error) => { failed.push({ id, error }); }).finally(() => active.delete(id));
    active.set(id, { issue, promise });
  };
  while (pending.length || active.size) {
    let started = false;
    if (shouldStop()) pending.length = 0;
    for (let i = 0; i < pending.length && active.size < workers;) {
      const issue = pending[i];
      if ([...active.values()].some(({ issue: other }) => conflicts(issue, other))) { i++; continue; }
      pending.splice(i, 1);
      launch(issue);
      started = true;
    }
    if (!active.size) {
      if (pending.length) {
        const issue = pending.shift();
        const item = { id: String(issue.id ?? issue.number), reason: 'conflicts_with_pending' };
        skipped.push(item); await onSkip(item);
      }
      continue;
    }
    if (!started || active.size >= workers) await Promise.race([...active.values()].map(({ promise }) => promise));
  }
  return { completed, skipped, failed };
}

