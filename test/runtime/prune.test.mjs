import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createResourceGovernor, prune } from '../../runtime/lib/prune.mjs';
import { hostId } from '../../runtime/lib/lock.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';
import { dispatch, openOutbox } from '../../runtime/lib/outbox.mjs';
import { runLoop } from '../../runtime/lib/daemon-loop.mjs';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const UID = process.getuid();
const LIVE_PID = process.pid;
// A pid of a process that has already exited: not alive on this host.
const DEAD_PID = spawnSync(process.execPath, ['-e', '']).pid;

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-prune-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A directory (or file) with its mtime set `ageMs` before NOW, so the test never depends on the real clock. */
async function aged(path, ageMs) {
  const at = new Date(NOW - ageMs);
  await utimes(path, at, at);
}

async function oldDir(path, ageMs, records = []) {
  await mkdir(path, { recursive: true });
  for (const [i, record] of records.entries()) await writeFile(join(path, `epoch-${i + 1}`), JSON.stringify(record));
  await aged(path, ageMs);
  return path;
}

const exists = (path) => existsSync(path);

test('RT-S6 prune removes only old, owned rt temp entries with no live pid and keeps the rest', async (t) => {
  const tmpRoot = await fixture(t);
  const anchorRoot = await fixture(t);
  const removable = [
    await oldDir(join(tmpRoot, 'rt-lock-old'), 31 * MIN),
    await oldDir(join(tmpRoot, 'rt-recovery-old'), 45 * MIN, [{ pid: DEAD_PID }]),
  ];
  const kept = [
    await oldDir(join(tmpRoot, 'rt-hard-live'), 60 * MIN, [{ pid: LIVE_PID }]),
    await oldDir(join(tmpRoot, 'rt-renewal-young'), 5 * MIN),
    await oldDir(join(tmpRoot, 'other-old'), 60 * MIN),
  ];
  const result = await prune({ tmpRoot, anchorRoot, uid: UID, now: NOW, tempAgeMs: 30 * MIN, lockAgeMs: 120 * MIN });
  assert.deepEqual(result.temp, removable);
  assert.deepEqual(result.locks, []);
  for (const path of removable) assert.equal(exists(path), false);
  for (const path of kept) assert.equal(exists(path), true);

  // Entries owned by another uid are never removed.
  const foreign = await oldDir(join(tmpRoot, 'rt-lock-foreign'), 60 * MIN);
  assert.deepEqual((await prune({ tmpRoot, anchorRoot, uid: UID + 1, now: NOW, tempAgeMs: 30 * MIN })).temp, []);
  assert.equal(exists(foreign), true);
});

test('RT-S6 lock directories older than 120 minutes with a dead holder are removed under the anchor, live ones kept', async (t) => {
  const tmpRoot = await fixture(t);
  const anchorRoot = await fixture(t);
  const repo = join(anchorRoot, 'locks', 'a'.repeat(64));
  const dead = await oldDir(join(repo, 'merge.lock.d'), 130 * MIN, [{ pid: DEAD_PID, hostId: hostId() }]);
  const live = await oldDir(join(repo, 'issue-1.lock.d'), 130 * MIN, [{ pid: LIVE_PID, hostId: hostId() }]);
  const young = await oldDir(join(repo, 'issue-2.lock.d'), 30 * MIN, [{ pid: DEAD_PID, hostId: hostId() }]);
  const otherHost = await oldDir(join(repo, 'issue-3.lock.d'), 130 * MIN, [{ pid: DEAD_PID, hostId: 'other-host-id' }]);
  const result = await prune({ tmpRoot, anchorRoot, uid: UID, now: NOW, tempAgeMs: 30 * MIN, lockAgeMs: 120 * MIN });
  assert.deepEqual(result.locks, [dead]);
  assert.equal(exists(dead), false);
  for (const path of [live, young, otherHost]) assert.equal(exists(path), true);
});

test('RT-S6 symlinks are never followed, nothing outside the two roots is removed, and dry-run only lists', async (t) => {
  const tmpRoot = await fixture(t);
  const anchorRoot = await fixture(t);
  const outside = await fixture(t);
  const victim = join(outside, 'keep.txt');
  await writeFile(victim, 'keep');
  await aged(victim, 999 * MIN);
  await aged(outside, 999 * MIN);
  // A temp entry that is itself a symlink to an old outside directory.
  await symlink(outside, join(tmpRoot, 'rt-lock-link'));
  // A real old temp entry holding a symlink to outside: removed, but the outside file survives.
  const real = join(tmpRoot, 'rt-lock-real');
  await mkdir(real);
  await symlink(outside, join(real, 'inner'));
  await aged(real, 60 * MIN);
  // An anchor repo directory that is a symlink to an outside repo with an old dead lock.
  const outsideRepo = join(outside, 'repo');
  await oldDir(join(outsideRepo, 'merge.lock.d'), 130 * MIN, [{ pid: DEAD_PID, hostId: hostId() }]);
  await mkdir(join(anchorRoot, 'locks'), { recursive: true });
  await symlink(outsideRepo, join(anchorRoot, 'locks', 'b'.repeat(64)));

  const listed = await prune({ tmpRoot, anchorRoot, uid: UID, now: NOW, tempAgeMs: 30 * MIN, lockAgeMs: 120 * MIN, dryRun: true });
  assert.deepEqual(listed, { temp: [real], locks: [] });
  assert.equal(exists(real), true);

  const result = await prune({ tmpRoot, anchorRoot, uid: UID, now: NOW, tempAgeMs: 30 * MIN, lockAgeMs: 120 * MIN });
  assert.deepEqual(result, { temp: [real], locks: [] });
  assert.equal(exists(real), false);
  assert.equal(exists(join(tmpRoot, 'rt-lock-link')), true);
  assert.equal(await readFile(victim, 'utf8'), 'keep');
  assert.equal(exists(join(outsideRepo, 'merge.lock.d')), true);
});

test('RT-S6 pruning runs at most once every 10 minutes, and each run that removes anything appends one self resource entry', async (t) => {
  const root = await fixture(t);
  const tmpRoot = await fixture(t);
  const anchorRoot = await fixture(t);
  let now = NOW;
  const gov = createResourceGovernor({ root, tmpRoot, anchorRoot, uid: UID, now: () => now });
  await oldDir(join(tmpRoot, 'rt-lock-a'), 60 * MIN);
  await gov.prune();
  assert.equal(exists(join(tmpRoot, 'rt-lock-a')), false);
  const ledger = () => openInterventions(root).entries().entries;
  assert.equal(ledger().length, 1);
  assert.deepEqual(
    { category: ledger()[0].category, ref: ledger()[0].ref, source: ledger()[0].source, internalized: ledger()[0].internalized },
    { category: 'resource', ref: 'none', source: 'self', internalized: 'no' },
  );
  assert.match(ledger()[0].reason, /^pruned 1 temp and 0 lock entries$/);
  assert.equal(ledger()[0].at, new Date(NOW).toISOString());

  // Within 10 minutes the run is skipped even though a new stale entry exists.
  const second = await oldDir(join(tmpRoot, 'rt-lock-b'), 60 * MIN);
  now = NOW + 9 * MIN;
  await gov.prune();
  assert.equal(exists(second), true);

  now = NOW + 10 * MIN;
  await gov.prune();
  assert.equal(exists(second), false);
  assert.equal(ledger().length, 2);

  // A run that removes nothing appends nothing.
  now = NOW + 20 * MIN;
  await gov.prune();
  assert.equal(ledger().length, 2);
});

test('RT-S6 disk budget closes admission when the state and anchor sizes or the free ratio are over budget, one alert per UTC day, deleting nothing', async (t) => {
  const root = await fixture(t);
  const anchorRoot = await fixture(t);
  const stateFile = join(root, '.roundtable', 'state', 'keep.txt');
  await mkdir(join(root, '.roundtable', 'state'), { recursive: true });
  await writeFile(stateFile, 'keep');
  let now = NOW;
  let bytes = 1024;
  let free = { bavail: 50, blocks: 100 };
  const gov = createResourceGovernor({
    root, tmpRoot: root, anchorRoot, uid: UID, now: () => now,
    size: async () => bytes,
    statfs: async () => free,
  });
  assert.equal(await gov.budget(), true);

  bytes = 512 * 1024 * 1024; // state plus anchor exceed stateMaxBytes (512 MiB) by the 1 KiB already counted
  assert.equal(await gov.budget(), false);
  assert.equal(await gov.budget(), false);
  const outbox = () => openOutbox(root).items().filter((item) => item.kind === 'notification');
  assert.deepEqual(outbox().map((item) => item.id), ['notice:disk-budget:2026-11-15']);

  bytes = 1024;
  free = { bavail: 4, blocks: 100 }; // free ratio 0.04 < minFreeRatio 0.05
  assert.equal(await gov.budget(), false);
  assert.equal(outbox().length, 1);

  now = NOW + 24 * 60 * MIN; // next UTC day: one more alert
  assert.equal(await gov.budget(), false);
  assert.deepEqual(outbox().map((item) => item.id), ['notice:disk-budget:2026-11-15', 'notice:disk-budget:2026-11-16']);
  assert.equal(await readFile(stateFile, 'utf8'), 'keep');
});

test('RT-S6 a closed disk budget gate still runs the cycle and dispatches the alert, but admits no new pass', async (t) => {
  const root = await fixture(t);
  const anchorRoot = await fixture(t);
  const gov = createResourceGovernor({ root, tmpRoot: root, anchorRoot, uid: UID, now: () => NOW, size: async () => 0, statfs: async () => ({ bavail: 0, blocks: 100 }) });
  const calls = [];
  const delivered = [];
  const ac = new AbortController();
  const code = await runLoop({
    // Stands in for the rtd pass: the inbox cycle, the admitted queue run, then the outbox dispatch.
    pass: async ({ admit }) => {
      calls.push(['cycle', admit]);
      if (admit) calls.push(['queue']);
      await dispatch({ outbox: openOutbox(root), provider: { deliver: async (item) => { delivered.push(item.id); return {}; } } });
    },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3,
    sleep: async () => ac.abort(), signal: ac.signal,
    prune: gov.prune, budget: gov.budget,
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [['cycle', false]]);
  assert.deepEqual(delivered, ['notice:disk-budget:2026-11-15']);
});

test('RT-S6 an open disk budget gate admits the queue run', async (t) => {
  const root = await fixture(t);
  const calls = [];
  const ac = new AbortController();
  const code = await runLoop({
    pass: async ({ admit }) => calls.push(admit),
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3,
    sleep: async () => ac.abort(), signal: ac.signal,
    budget: async () => true,
  });
  assert.equal(code, 0);
  assert.deepEqual(calls, [true]);
});
