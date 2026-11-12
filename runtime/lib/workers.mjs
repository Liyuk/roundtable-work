import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from './lock.mjs';
import { assertSafeId, createConfinement } from './paths.mjs';
import { dependencies as dependenciesFromBody } from './intake.mjs';

const seriesOf = (issue) => issue.series ?? /^\[([^\]]+)\]/.exec(issue.title ?? '')?.[1]?.toLowerCase() ?? null;
const depsOf = (issue) => new Set([...(issue.dependencies ?? issue.dependsOn ?? []), ...dependenciesFromBody(issue.body ?? '')].map(String));
function conflicts(a, b) {
  if (a.id === b.id) return true;
  const sa = seriesOf(a), sb = seriesOf(b);
  if (sa && sb && sa.toLowerCase() === sb.toLowerCase()) return true;
  return depsOf(a).has(String(b.id)) || depsOf(b).has(String(a.id));
}

/** Run eligible issues with cross-process per-issue locks and in-process series/dependency exclusion. */
export async function runWorkers({ issues, workRoot, workers = 2, run, now = Date.now, lockTtlMs = 60_000, worktreeManager, prepare = async () => true, shouldStop = () => false, onSkip = () => {} }) {
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
      const lock = await acquireLock({ lockPath: join(lockRoot, `${id}.lock.d`), owner: `worker-${process.pid}-${id}`, now, ttlMs: lockTtlMs });
      if (!lock.acquired) {
        const item = { id, reason: 'issue_locked', holder: lock.holder };
        skipped.push(item); await onSkip(item); return;
      }
      const controller = new AbortController();
      let renewal = null, lockLost = false;
      const timer = setInterval(() => {
        if (renewal || lockLost) return;
        renewal = lock.refresh().then((ok) => {
          if (!ok) { lockLost = true; controller.abort(new Error('issue lock lost')); }
        }, (error) => {
          lockLost = true;
          controller.abort(error);
        }).finally(() => { renewal = null; });
      }, Math.max(1, Math.floor(lockTtlMs / 3)));
      timer.unref();
      try {
        if (!(await prepare(issue))) return;
        const worktree = worktreeManager ? await worktreeManager.create(id) : undefined;
        await run(issue, { id, lock, workRoot: confinement.root, worktree: worktree?.path, existingWorktree: worktree?.existing ?? false, signal: controller.signal });
        if (lockLost) throw new Error('issue lock lost');
        completed.push(id);
      } finally {
        clearInterval(timer);
        await renewal;
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

