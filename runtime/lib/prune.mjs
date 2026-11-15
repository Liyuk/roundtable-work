// RT-S6 resource governor: deterministic prune of leaked `rt-*` temp directories and stale anchor lock directories,
// a 10-minute throttle, one `self` ledger entry per pruning run that removed something, and a state-dir disk budget
// that closes admission (it never deletes data). Symlinks are never followed; only the two roots are touched.
import { readFileSync } from 'node:fs';
import { lstat, readdir, readFile, rm, statfs as statfsOf } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorRootOf, hostId, pidAlive } from './lock.mjs';
import { openInterventions } from './interventions.mjs';
import { openOutbox } from './outbox.mjs';

const DEFAULTS = JSON.parse(readFileSync(fileURLToPath(new URL('../defaults/prune.json', import.meta.url)), 'utf8'));
const TEMP_NAME = /^rt-(?:lock|hard|recovery|renewal)-/;
const MIN = 60_000;
const MAX_RECORD_BYTES = 4096;

/** Non-symlink entries of `dir` (lstat), empty when the directory is missing. */
async function entriesOf(dir) {
  const out = [];
  for (const name of await readdir(dir).catch(() => [])) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (st) out.push({ name, path, st });
  }
  return out;
}

/** JSON object records of the regular files in `dir`, and in its subdirectories down to `depth`. */
async function recordsIn(dir, depth = 1) {
  const out = [];
  for (const { path, st } of await entriesOf(dir)) {
    if (st.isDirectory() && depth > 0) out.push(...await recordsIn(path, depth - 1));
    else if (st.isFile() && st.size <= MAX_RECORD_BYTES) out.push(await readRecord(path));
  }
  return out.filter(Boolean);
}

async function readRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** A record keeps its directory while its pid is alive, or while it belongs to another host (never judged here). */
const live = (record) => (record.hostId !== undefined && record.hostId !== hostId()) || pidAlive(record.pid);

/**
 * Remove stale `rt-lock-*`, `rt-hard-*`, `rt-recovery-*`, `rt-renewal-*` temp directories and stale lock directories
 * (`<anchor>/locks/<repo-id>/<lock>`) that are older than their age and owned by `uid`, with no live holder record.
 * Resolves the lists of removed paths; with `dryRun` nothing is deleted.
 */
export async function prune({ tmpRoot = tmpdir(), anchorRoot = anchorRootOf(), uid = process.getuid(), now = Date.now(), tempAgeMs = 30 * MIN, lockAgeMs = 120 * MIN, dryRun = false } = {}) {
  const temp = [];
  for (const { name, path, st } of await entriesOf(tmpRoot)) {
    if (!TEMP_NAME.test(name) || !st.isDirectory() || st.uid !== uid || now - st.mtimeMs < tempAgeMs) continue;
    if (!(await recordsIn(path)).some(live)) temp.push(path);
  }
  const locks = [];
  for (const repo of await entriesOf(join(anchorRoot, 'locks'))) {
    if (!repo.st.isDirectory()) continue;
    for (const { path, st } of await entriesOf(repo.path)) {
      if (!st.isDirectory() || st.uid !== uid || now - st.mtimeMs < lockAgeMs) continue;
      const records = await recordsIn(path);
      if (records.length && !records.some(live)) locks.push(path);
    }
  }
  if (!dryRun) for (const path of [...temp, ...locks]) await rm(path, { recursive: true, force: true });
  return { temp, locks };
}

/** Recursive size in bytes of the real files under `path` (symlinks are not followed; a missing path is 0). */
async function dirBytes(path) {
  let total = 0;
  for (const { st, path: child } of await entriesOf(path)) {
    if (st.isDirectory()) total += await dirBytes(child);
    else if (st.isFile()) total += st.size;
  }
  return total;
}

/**
 * The governor for one workspace `root`. `prune()` is throttled to one run per `throttleMinutes`; a run that removed
 * something appends one `self` resource entry. `budget()` resolves true to admit new lines, false when the state dir
 * plus the anchor root exceed `stateMaxBytes` or the free ratio of the workspace filesystem is below `minFreeRatio`;
 * a closed budget enqueues one notification per UTC day.
 */
export function createResourceGovernor({
  root, tmpRoot = tmpdir(), anchorRoot = anchorRootOf(), uid = process.getuid(), now = Date.now,
  size = dirBytes, statfs = statfsOf, config = DEFAULTS,
}) {
  const stateDir = join(root, '.roundtable', 'state');
  let lastRun = -Infinity;
  return {
    async prune() {
      const t = now();
      if (t - lastRun < config.throttleMinutes * MIN) return;
      lastRun = t;
      const { temp, locks } = await prune({ tmpRoot, anchorRoot, uid, now: t, tempAgeMs: config.tempAgeMinutes * MIN, lockAgeMs: config.lockAgeMinutes * MIN });
      if (temp.length + locks.length === 0) return;
      openInterventions(root).append({
        category: 'resource', ref: 'none', source: 'self', internalized: 'no',
        reason: `pruned ${temp.length} temp and ${locks.length} lock entries`, at: new Date(t).toISOString(),
      }, { key: `prune:${t}` });
    },
    async budget() {
      const bytes = (await size(stateDir)) + (await size(anchorRoot));
      const { bavail, blocks } = await statfs(root);
      if (bytes <= config.stateMaxBytes && bavail / blocks >= config.minFreeRatio) return true;
      const day = new Date(now()).toISOString().slice(0, 10);
      openOutbox(root).enqueue({ id: `notice:disk-budget:${day}`, kind: 'notification', issue: null, payload: { subtype: 'disk-budget' } });
      return false;
    },
  };
}
