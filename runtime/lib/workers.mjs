import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireLock } from './lock.mjs';
import { assertSafeId, createConfinement } from './paths.mjs';
import { dependencies as dependenciesFromBody } from './intake.mjs';
import { lockKeysOf, overlaps, parseTouchSet } from './touch-set.mjs';
import { seriesKey } from './series-key.mjs';

const seriesOf = (issue) => issue.series ?? seriesKey(issue.title);
const depsOf = (issue) => new Set([...(issue.dependencies ?? issue.dependsOn ?? []), ...dependenciesFromBody(issue.body ?? '')].map(String));
const idOf = (issue) => String(issue.id ?? issue.number);

/**
 * Why `a` and `b` must not run together, or null. Checked in order: dependency, touch-set overlap, series fallback.
 * Disjoint parseable touch sets never serialize on series. A missing or unparseable touch set overlaps everything.
 */
export function serializationReason(a, b) {
  if (a.id === b.id) return 'duplicate id';
  if (depsOf(a).has(String(b.id)) || depsOf(b).has(String(a.id))) return 'dependency';
  const ta = parseTouchSet(a.body ?? ''), tb = parseTouchSet(b.body ?? '');
  if (ta && tb) return ta.some((p) => tb.some((q) => overlaps(p, q))) ? 'touch-set overlap' : null;
  const sa = seriesOf(a), sb = seriesOf(b);
  if (sa && sb && sa.toLowerCase() === sb.toLowerCase()) return 'series fallback';
  return 'touch-set overlap';
}

// In-process holds of cross-process touch lock keys. Ancestor keys are shared by siblings (`runtime/lib/a.mjs` and
// `runtime/lib/b.mjs` both hold `runtime/lib`), so each key is held once per process and reference-counted; exact
// overlap between in-process issues is already excluded by `serializationReason`. Operations per key are queued.
const touchHolds = new Map();
const touchQueues = new Map();
const queued = (id, fn) => {
  const run = (touchQueues.get(id) ?? Promise.resolve()).then(fn);
  touchQueues.set(id, run.catch(() => {}));
  return run;
};

async function holdTouch({ lockRoot, key, owner, repoRoot, now, lockTtlMs }) {
  const id = `${lockRoot}\0${key}`;
  return queued(id, async () => {
    let hold = touchHolds.get(id);
    if (!hold) {
      const lock = await acquireLock({ lockPath: join(lockRoot, `touch-${createHash('sha256').update(key).digest('hex')}.lock.d`), repoRoot, owner, now, ttlMs: lockTtlMs });
      if (!lock.acquired) return { acquired: false, holder: lock.holder };
      hold = { id, lock, refs: 0 };
      touchHolds.set(id, hold);
    }
    hold.refs++;
    return { acquired: true, hold };
  });
}

const dropTouch = (hold) => queued(hold.id, async () => {
  if (--hold.refs) return;
  touchHolds.delete(hold.id);
  await hold.lock.release().catch(() => false);
});

/** Run eligible issues with cross-process per-issue locks and in-process series/dependency/touch-set exclusion. `workers` may be a number or a () => number evaluated each pass. */
export async function runWorkers({ issues, workRoot, repoRoot, workers = 2, run, now = Date.now, lockTtlMs = 60_000, worktreeManager, prepare = async () => true, shouldStop = () => false, onSkip = () => {}, onSerialize = () => {} }) {
  if (!Array.isArray(issues) || typeof run !== 'function') throw new TypeError('issues and run are required');
  if (typeof workers !== 'function' && (!Number.isSafeInteger(workers) || workers < 1)) throw new TypeError('workers must be a positive integer or a function returning one');
  const limit = typeof workers === 'function' ? workers : () => workers;
  const confinement = await createConfinement(workRoot);
  const lockRoot = await confinement.resolve('locks');
  await mkdir(lockRoot, { recursive: true, mode: 0o700 });
  const pending = [...issues];
  const active = new Map();
  const reported = new Set();
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
        renewal = Promise.all([lock, ...touchLocks.map((hold) => hold.lock)].map((handle) => handle.refresh())).then((results) => {
          if (!results.every(Boolean)) { lockLost = true; controller.abort(new Error('issue lock lost')); }
        }, (error) => {
          lockLost = true;
          controller.abort(error);
        }).finally(() => { renewal = null; });
      }, Math.max(1, Math.floor(lockTtlMs / 3)));
      timer.unref();
      try {
        for (const key of lockKeysOf(parseTouchSet(issue.body ?? '') ?? [])) {
          const touch = await holdTouch({ lockRoot, key, owner: `worker-${process.pid}-${id}`, repoRoot: repoRoot ?? confinement.root, now, lockTtlMs });
          if (!touch.acquired) {
            const item = { id, reason: 'touch_set_locked', holder: touch.holder };
            skipped.push(item); await onSkip(item); return;
          }
          touchLocks.push(touch.hold);
        }
        if (!(await prepare(issue))) return;
        const worktree = worktreeManager ? await worktreeManager.create(id) : undefined;
        await run(issue, { id, lock, workRoot: confinement.root, worktree: worktree?.path, existingWorktree: worktree?.existing ?? false, signal: controller.signal });
        if (lockLost) throw new Error('issue lock lost');
        completed.push(id);
      } finally {
        clearInterval(timer);
        await renewal;
        await Promise.all(touchLocks.map(dropTouch));
        await lock.release().catch(() => false);
      }
    })().catch((error) => { failed.push({ id, error }); }).finally(() => active.delete(id));
    active.set(id, { issue, promise });
  };
  while (pending.length || active.size) {
    let started = false;
    if (shouldStop()) pending.length = 0;
    const cap = limit();
    for (let i = 0; i < pending.length && active.size < cap;) {
      const issue = pending[i];
      const blocker = [...active.values()].map(({ issue: other }) => ({ other, reason: serializationReason(issue, other) })).find(({ reason }) => reason);
      if (blocker) {
        const key = `${idOf(issue)}\0${idOf(blocker.other)}`;
        if (!reported.has(key)) { reported.add(key); await onSerialize({ id: idOf(issue), other: idOf(blocker.other), reason: blocker.reason }); }
        i++; continue;
      }
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
    if (!started || active.size >= cap) await Promise.race([...active.values()].map(({ promise }) => promise));
  }
  return { completed, skipped, failed };
}

