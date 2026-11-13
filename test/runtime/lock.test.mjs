import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import * as realFs from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireLock, anchorRootOf, hostId, lockDirectoryFor } from '../../runtime/lib/lock.mjs';

// RT_LOCK_MODULE lets a reviewer point the child processes at another implementation (e.g. to show
// that the test fails against an older lock); by default the real module is used.
const LOCK_MODULE = process.env.RT_LOCK_MODULE
  ? pathToFileURL(process.env.RT_LOCK_MODULE).href
  : new URL('../../runtime/lib/lock.mjs', import.meta.url).href;
// Lock records live in the private anchor, never in the work root: RTW_STATE_DIR (inherited by the child
// processes below) points at a per-file temporary anchor, and the work roots stay ordinary temporary dirs.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-lock-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
after(() => rm(ANCHOR, { recursive: true, force: true }));
const tmp = () => mkdtemp(join(tmpdir(), 'rt-lock-'));
const exists = (p) => access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The path the caller acquires and the directory that (only) the anchor holds are deliberately different.
const lockPathOf = (dir, name = 'rtd.lock.d') => join(dir, name);
const lockDir = (dir, name = 'rtd.lock.d') => lockDirectoryFor({ lockPath: lockPathOf(dir, name), repoRoot: dir, anchorRoot: ANCHOR });
/** Anchored directory of a lock path whose repo root is its own parent (`withDir` fixtures). */
const anchor = (lockPath) => lockDirectoryFor({ lockPath, repoRoot: dirname(lockPath), anchorRoot: ANCHOR });
const epochsOf = async (dir) => (await readdir(lockDir(dir))).map((n) => /^epoch-(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
const readEpochFile = async (dir, n) => JSON.parse(await readFile(join(lockDir(dir), `epoch-${n}`), 'utf8'));
const topEpoch = async (dir) => { const e = await epochsOf(dir); return e[e.length - 1]; };
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '']); assert.equal(r.status, 0); return r.pid; };
const withDir = (fn) => async () => { const dir = await tmp(); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } };
const clockAt = (t) => { const c = { t }; c.now = () => c.t; return c; };

/** Write a holder record as `epoch-<n>` (what an earlier or a foreign process would have left). */
async function plantEpoch(dir, n, rec) {
  await mkdir(lockDir(dir), { recursive: true, mode: 0o700 });
  const body = { owner: 'planted', pid: process.pid, hostId: hostId(), token: `planted-${n}`, epoch: n, acquiredAt: 1, expiresAt: Date.now() + 3_600_000, ...rec };
  await writeFile(join(lockDir(dir), `epoch-${n}`), JSON.stringify(body));
  return body;
}
const plantStale = (dir, n = 1) => plantEpoch(dir, n, { pid: deadPid(), owner: 'old' });

/** A pause point: `reached` resolves when the code under test gets there, `open()` lets it continue. */
function gate() {
  let open; let reach;
  const wait = new Promise((r) => { open = r; });
  const reached = new Promise((r) => { reach = r; });
  return { reached, open, hook: async () => { reach(); await wait; } };
}

const CONTENDER = `
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const { acquireLock } = await import(process.env.RT_LOCK_MODULE_URL);
const dir = process.env.RT_DIR;
const name = process.env.RT_NAME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => sleep(Math.floor(Math.random() * 6));
const __hooks = process.env.RT_JITTER ? { afterList: jitter, beforeLink: jitter, afterLink: jitter, beforeRefreshWrite: jitter, afterRefreshWrite: jitter } : {};
writeFileSync(join(dir, 'ready.' + name), '');
while (!existsSync(join(dir, 'start'))) await sleep(1);
const names = process.env.RT_NAMES.split(',');
let lock;
try { lock = await acquireLock({ lockPath: join(dir, 'rtd.lock.d'), owner: name, ttlMs: 60000, __hooks }); }
catch { lock = { acquired: false }; }
if (lock.acquired) appendFileSync(join(dir, 'events.log'), JSON.stringify({ name, ev: 'acquire', epoch: lock.epoch, t: process.hrtime.bigint().toString() }) + '\\n');
// done.<name>: this contender's attempt is over (it won, lost, or gave up).
writeFileSync(join(dir, 'done.' + name), '');
if (lock.acquired) {
  // Hold the lock until every other contender has finished (won or given up), so a slow contender can never
  // legitimately acquire after the release, whatever the CPU load. The cap only guards against a hung child.
  const others = names.filter((n) => n !== name).map((n) => join(dir, 'done.' + n));
  for (let i = 0; i < 4000 && !others.every((f) => existsSync(f)); i++) await sleep(5);
  const refreshed = await lock.refresh().catch(() => false);
  appendFileSync(join(dir, 'events.log'), JSON.stringify({ name, ev: 'release', refreshed, t: process.hrtime.bigint().toString() }) + '\\n');
  await lock.release();
}
`;

function runChild(script, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', process.env.RT_DEBUG ? 'inherit' : 'ignore'] });
  return new Promise((resolve) => child.on('close', resolve));
}

async function waitForFiles(paths) {
  for (let i = 0; i < 1000; i++) {
    if ((await Promise.all(paths.map(exists))).every(Boolean)) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for contenders');
}

/** Run `procs` contenders per round for `rounds` rounds; `seed(dir, round)` prepares the lock directory. */
async function stress({ procs, rounds, seed, jitter = false }) {
  for (let round = 0; round < rounds; round++) {
    const dir = await tmp();
    try {
      await seed(dir, round);
      const names = Array.from({ length: procs }, (_, i) => `p${i}`);
      const env = { RT_DIR: dir, RT_NAMES: names.join(','), RT_LOCK_MODULE_URL: LOCK_MODULE, ...(jitter ? { RT_JITTER: '1' } : {}) };
      const done = names.map((name) => runChild(CONTENDER, { ...env, RT_NAME: name }));
      await waitForFiles(names.map((n) => join(dir, `ready.${n}`)));
      await writeFile(join(dir, 'start'), '');
      assert.deepEqual(await Promise.all(done), names.map(() => 0));

      const events = (await readFile(join(dir, 'events.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      const acquires = events.filter((e) => e.ev === 'acquire');
      assert.equal(acquires.length, 1, `round ${round}: expected exactly one winner, got ${acquires.map((a) => a.name)}`);
      assert.equal(events.find((e) => e.ev === 'release').refreshed, true, `round ${round}: the winner could refresh while contenders kept failing`);
      // Interval check: no two holds overlap.
      let holders = 0;
      for (const e of events.sort((a, b) => (BigInt(a.t) < BigInt(b.t) ? -1 : 1))) {
        holders += e.ev === 'acquire' ? 1 : -1;
        assert.ok(holders <= 1, `round ${round}: two holders at once`);
      }
      const epochs = await epochsOf(dir);
      assert.equal(epochs[epochs.length - 1], acquires[0].epoch, `round ${round}: the winner owns the highest epoch`);
      assert.equal(new Set(epochs).size, epochs.length);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
}

// ---------------------------------------------------------------------------------------------
// Real processes

test('lock: stale takeover is mutually exclusive across real processes: one winner per round, never two holders', { timeout: 60000 }, async () => {
  const dead = deadPid();
  await stress({ procs: 6, rounds: 10, seed: (dir) => plantEpoch(dir, 1, { pid: dead, owner: 'old' }) });
});

// L4
test('lock: N processes x M rounds, stale holder plus orphan mutex/guard, never two holders', { timeout: 60000 }, async () => {
  const dead = deadPid();
  await stress({
    procs: 8, rounds: 8, jitter: true,
    seed: async (dir, round) => {
      await plantEpoch(dir, 1 + round, { pid: dead, owner: 'old' });
      // Leftovers of the previous implementation and of crashed writers, inside and beside the lock directory.
      const orphan = JSON.stringify({ pid: dead, id: 'orphan', expiresAt: round % 2 ? 1 : Date.now() + 3_600_000 });
      await writeFile(`${lockDir(dir)}.mutex`, orphan);
      await writeFile(`${lockDir(dir)}.mutex.break`, orphan);
      await writeFile(join(lockDir(dir), '.mutex'), orphan);
      await writeFile(join(lockDir(dir), `.tmp-orphan-${round}`), '{"pid"');
      await writeFile(join(lockDir(dir), `epoch-${2 + round}.tmp`), orphan);
      await writeFile(join(lockDir(dir), 'epoch-x'), orphan);
    },
  });
});

// ---------------------------------------------------------------------------------------------
// In-process behaviour

test('lock: in-process contenders racing for an expired lock yield exactly one holder', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const first = await acquireLock({ lockPath, owner: 'first', now: clock.now, ttlMs: 100 });
  assert.equal(first.acquired, true);
  assert.equal(first.epoch, 1);
  clock.t += 101;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireLock({ lockPath, owner: `c${i}`, now: clock.now, ttlMs: 100 })));
  assert.equal(results.filter((r) => r.acquired).length, 1);
  const winner = results.find((r) => r.acquired);
  assert.equal(winner.epoch, 2);
  assert.equal((await readEpochFile(dir, 2)).token, winner.token);
  assert.equal(await first.refresh(), false);
  assert.equal(await winner.refresh(), true);
  assert.equal(await winner.release(), true);
  assert.equal((await readEpochFile(dir, 2)).released, true, 'release marks the file, it does not unlink it');
  // The only thing written into the work root is the anchor-domain marker: a hash, no path and no host data.
  assert.deepEqual(await readdir(dir), ['.roundtable']);
  assert.deepEqual(await readdir(join(dir, '.roundtable')), ['lock-domain']);
  const markerPath = join(dir, '.roundtable', 'lock-domain');
  const marker = await readFile(markerPath, 'utf8');
  assert.equal(marker, JSON.stringify({ version: 1, anchor: createHash('sha256').update(realpathSync(ANCHOR)).digest('hex') }));
  assert.equal((await stat(markerPath)).mode & 0o777, 0o600, 'the marker is private');
  assert.ok(!marker.includes(ANCHOR) && !marker.includes(tmpdir()), 'the marker never carries the anchor path');
}));

test('lock: a displaced holder cannot refresh over or release its successor\'s lock', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const a = await acquireLock({ lockPath, owner: 'a', now: clock.now, ttlMs: 100 });
  clock.t += 101;
  const b = await acquireLock({ lockPath, owner: 'b', now: clock.now, ttlMs: 100 });
  assert.equal(b.acquired, true);
  const before = await readFile(join(anchor(lockPath), 'epoch-2'), 'utf8');
  assert.equal(await a.refresh(), false);
  await a.release();
  assert.equal(await readFile(join(anchor(lockPath), 'epoch-2'), 'utf8'), before, 'the successor\'s file is byte for byte unchanged');
  assert.equal(await b.refresh(), true);
}));

test('lock: a live holder with a fresh lease is never taken over, and its lock file is left untouched', withDir(async (dir) => {
  const lockPath = lockPathOf(dir);
  const a = await acquireLock({ lockPath, owner: 'a' });
  const before = await readFile(join(anchor(lockPath), 'epoch-1'), 'utf8');
  const results = await Promise.all(Array.from({ length: 6 }, () => acquireLock({ lockPath, owner: 'x' })));
  assert.deepEqual(results.map((r) => r.acquired), Array(6).fill(false));
  assert.deepEqual(results.map((r) => r.reason), Array(6).fill('held'));
  assert.equal(results[0].holder.token, a.token);
  assert.equal(await readFile(join(anchor(lockPath), 'epoch-1'), 'utf8'), before);
  assert.deepEqual(await epochsOf(dir), [1]);
  await a.release();
}));

test('lock: only epochs far below the newest are garbage collected, after a successful acquire', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  for (let i = 0; i < 12; i++) {
    const h = await acquireLock({ lockPath, owner: `o${i}`, now: clock.now, ttlMs: 10 });
    assert.equal(h.acquired, true);
    assert.equal(h.epoch, i + 1);
    clock.t += 11;
  }
  assert.deepEqual(await epochsOf(dir), [4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const live = await acquireLock({ lockPath, owner: 'x', now: clock.now, ttlMs: 1000 });
  assert.equal(live.acquired, true);
  const failed = await acquireLock({ lockPath, owner: 'y', now: clock.now, ttlMs: 1000 });
  assert.equal(failed.acquired, false);
  assert.deepEqual(await epochsOf(dir), [5, 6, 7, 8, 9, 10, 11, 12, 13], 'a failed acquire collects nothing');
}));

// L1
test('lock: refresh never writes through a planted symlink', withDir(async (dir) => {
  const outside = await tmp();
  try {
    const sentinel = join(outside, 'sentinel.txt');
    await writeFile(sentinel, 'do not touch');
    const lockPath = lockPathOf(dir);
    const h = await acquireLock({ lockPath, owner: 'a' });
    assert.equal(h.acquired, true);
    // The refresh temp name the previous implementation used (pid and token are readable from the lock file).
    const oldNames = [`${anchor(lockPath)}.${process.pid}.${h.token}.refresh`, join(anchor(lockPath), `${process.pid}.${h.token}.refresh`), join(anchor(lockPath), `epoch-${h.epoch}.refresh`), join(anchor(lockPath), `epoch-${h.epoch}.tmp`)];
    for (const name of oldNames) await symlink(sentinel, name);
    let result;
    try { result = await h.refresh(); } catch { result = 'threw'; }
    assert.equal(await readFile(sentinel, 'utf8'), 'do not touch', 'nothing was written through the symlink');
    assert.equal(result, true, 'a fresh random temp name is used, the planted names are irrelevant');
    assert.equal((await lstat(join(anchor(lockPath), `epoch-${h.epoch}`))).isFile(), true);
    for (const name of oldNames) assert.equal((await lstat(name)).isSymbolicLink(), true, 'the planted symlink is left alone');
    // A leftover regular file at that name does not block refresh either.
    for (const name of oldNames) { await rm(name); await writeFile(name, 'leftover'); }
    assert.equal(await h.refresh(), true);
    for (const name of oldNames) assert.equal(await readFile(name, 'utf8'), 'leftover');
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

// L2
test('lock: two breakers can never both hold the guard', withDir(async (dir) => {
  // Contenders A and B both judged the stale epoch-1 stale and sit right before their link(); then C and D start.
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  await plantStale(dir, 1);
  const gA = gate(); const gB = gate();
  const A = acquireLock({ lockPath, owner: 'A', now: clock.now, ttlMs: 100, __hooks: { beforeLink: gA.hook } });
  const B = acquireLock({ lockPath, owner: 'B', now: clock.now, ttlMs: 100, __hooks: { beforeLink: gB.hook } });
  await Promise.all([gA.reached, gB.reached]);
  gB.open();
  const b = await B;
  assert.equal(b.acquired, true);
  assert.equal(b.epoch, 2);
  // C and D arrive while A is paused: the lock is live, nobody enters.
  const [c, d] = await Promise.all([acquireLock({ lockPath, owner: 'C', now: clock.now, ttlMs: 100 }), acquireLock({ lockPath, owner: 'D', now: clock.now, ttlMs: 100 })]);
  assert.deepEqual([c.acquired, d.acquired], [false, false]);
  gA.open();
  const a = await A;
  assert.equal(a.acquired, false, 'A\'s link() hit EEXIST: exactly one link succeeded for epoch-2');
  assert.deepEqual(await epochsOf(dir), [1, 2]);
  assert.equal((await readEpochFile(dir, 2)).token, b.token);
  assert.equal(await b.refresh(), true);

  // B stalls past its lease; E and F race for epoch-3 while the paused B holds nothing valid anymore.
  clock.t += 101;
  const gE = gate(); const gF = gate();
  const E = acquireLock({ lockPath, owner: 'E', now: clock.now, ttlMs: 100, __hooks: { beforeLink: gE.hook } });
  const F = acquireLock({ lockPath, owner: 'F', now: clock.now, ttlMs: 100, __hooks: { beforeLink: gF.hook } });
  await Promise.all([gE.reached, gF.reached]);
  gE.open(); gF.open();
  const results = await Promise.all([E, F]);
  assert.equal(results.filter((r) => r.acquired).length, 1);
  assert.deepEqual(await epochsOf(dir), [1, 2, 3]);
  assert.equal(await b.refresh(), false);

  // A contender that was paused right after its link() and then superseded must not report acquired.
  clock.t += 101;
  const gG = gate();
  const G = acquireLock({ lockPath, owner: 'G', now: clock.now, ttlMs: 100, __hooks: { afterLink: gG.hook } });
  await gG.reached;
  assert.deepEqual(await epochsOf(dir), [1, 2, 3, 4]);
  clock.t += 101; // G's lease ran out while it was paused
  const h = await acquireLock({ lockPath, owner: 'H', now: clock.now, ttlMs: 100 });
  assert.equal(h.acquired, true);
  assert.equal(h.epoch, 5);
  gG.open();
  const g = await G;
  assert.equal(g.acquired, false);
  assert.equal(g.reason, 'superseded');
}));

// L3
test('lock: a live but slow holder is never overlapped and never loses or damages anything to a successor', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const g = gate();
  let stall = false;
  const h = await acquireLock({ lockPath, owner: 'H', now: clock.now, ttlMs: 1000, __hooks: { beforeRefreshWrite: () => (stall ? g.hook() : undefined) } });
  clock.t += 900;
  const c1 = await acquireLock({ lockPath, owner: 'C', now: clock.now, ttlMs: 1000 });
  assert.deepEqual([c1.acquired, c1.reason], [false, 'held'], 'a live holder inside its lease is not overlapped');
  // H stalls inside refresh (checks passed, nothing written yet), then more than a whole lease passes.
  stall = true;
  const stalledRefresh = h.refresh();
  await g.reached;
  clock.t += 1101;
  const c2 = await acquireLock({ lockPath, owner: 'C', now: clock.now, ttlMs: 1000 });
  assert.equal(c2.acquired, true);
  const successorFile = join(anchor(lockPath), `epoch-${c2.epoch}`);
  const inode = (await stat(successorFile)).ino;
  const bytes = await readFile(successorFile, 'utf8');
  g.open();
  assert.equal(await stalledRefresh, false, 'the stalled holder\'s refresh reports lost');
  assert.equal(await h.release(), true);
  assert.equal((await stat(successorFile)).ino, inode, 'the stalled holder never touched a file it did not create');
  assert.equal(await readFile(successorFile, 'utf8'), bytes);
  // No mutex or guard exists anywhere, so there is nothing a stalled holder could break or delete.
  assert.deepEqual([...await readdir(dir), ...await readdir(anchor(lockPath))].filter((n) => /mutex|break/.test(n)), []);
}));

// L6: a refresh that completes after its own previous lease ran out cannot coexist with a takeover
test('lock: a refresh stalled past its own expiry is lost, never valid next to a takeover', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const gA = gate();
  const gB = gate();
  const A = await acquireLock({ lockPath, owner: 'A', now: clock.now, ttlMs: 100, __hooks: { beforeRefreshWrite: gA.hook } });
  assert.equal(A.acquired, true);
  const aRefresh = A.refresh(); // pre-checks pass: lease not yet expired, no higher epoch
  await gA.reached;
  clock.t = 1200; // A stalls and its lease runs out
  const bAcquire = acquireLock({ lockPath, owner: 'B', now: clock.now, ttlMs: 100, __hooks: { beforeLink: gB.hook } });
  await gB.reached; // B read A's old file, judged it stale, and is about to link epoch 2
  gA.open();
  const refreshed = await aRefresh; // A renames and runs its post-check; no higher epoch exists yet
  gB.open();
  const B = await bAcquire;
  assert.equal(refreshed && B.acquired, false, 'never two valid holders');
  assert.equal(B.acquired, true, 'the takeover based on the expired file succeeds');
  assert.equal(refreshed, false, 'so the refresh must not report a valid lease');
  assert.equal(await A.refresh(), false, 'the handle stays lost');
  const aFile = await readEpochFile(dir, 1);
  assert.equal(aFile.released, true, 'the lost handle\'s file never claims a live lease');
  assert.equal((await readEpochFile(dir, 2)).token, B.token);
  assert.equal(await B.refresh(), true);
}));

test('lock: a refresh stalled past its expiry, with nobody taking over, leaves no live lease behind', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const gA = gate();
  const A = await acquireLock({ lockPath, owner: 'A', now: clock.now, ttlMs: 100, __hooks: { beforeRefreshWrite: gA.hook } });
  const aRefresh = A.refresh();
  await gA.reached;
  clock.t = 1200;
  gA.open();
  assert.equal(await aRefresh, false);
  const B = await acquireLock({ lockPath, owner: 'B', now: clock.now, ttlMs: 100 });
  assert.equal(B.acquired, true, 'the lock is not held by a handle that reported false');
  assert.equal(B.epoch, 2);
}));

test('lock: randomized interleavings (virtual clock, random yields) never show two valid holders', { timeout: 20000 }, async () => {
  const TTL = 50;
  const HOOKS = ['afterList', 'beforeLink', 'afterLink', 'beforeRefreshWrite', 'afterRefreshWrite'];
  for (const seed0 of [1, 42, 99991]) {
    const dir = await tmp();
    try {
      let seed = seed0;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
      const clock = clockAt(1000);
      const valid = new Map(); // worker -> expiry of the last grant its own handle reported (acquire or refresh == true)
      let violations = 0;
      let grants = 0;
      const check = () => { if ([...valid.values()].filter((e) => e > clock.t).length > 1) violations++; };
      const yieldy = async () => {
        for (let i = Math.floor(rnd() * 4); i > 0; i--) await new Promise((r) => setImmediate(r));
        if (rnd() < 0.3) { clock.t += Math.floor(rnd() * 30); check(); }
      };
      const hooks = Object.fromEntries(HOOKS.map((n) => [n, yieldy]));
      const worker = async (name) => {
        for (let r = 0; r < 50; r++) {
          const t0 = clock.t;
          const h = await acquireLock({ lockPath: lockPathOf(dir), owner: name, now: clock.now, ttlMs: TTL, isAlive: () => true, __hooks: hooks });
          if (!h.acquired) { await yieldy(); continue; }
          grants++;
          valid.set(name, t0 + TTL); // lower bound of the granted lease: the record is stamped no earlier than t0
          check();
          for (let i = 0; i < 4; i++) {
            await yieldy();
            const t1 = clock.t;
            if (!(await h.refresh())) { valid.delete(name); break; }
            valid.set(name, t1 + TTL);
            check();
          }
          if (valid.has(name)) { valid.delete(name); await h.release(); }
        }
      };
      await Promise.all(['a', 'b', 'c', 'd'].map(worker));
      assert.equal(violations, 0, `seed ${seed0}: two valid holders at once`);
      assert.ok(grants > 20, `seed ${seed0}: the run made progress (${grants} grants)`);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

// L5
test('lock: refresh while a foreign live mutex is present', withDir(async (dir) => {
  const lockPath = lockPathOf(dir);
  await plantStale(dir, 3);
  const h = await acquireLock({ lockPath, owner: 'a' });
  assert.equal(h.epoch, 4);
  const live = JSON.stringify({ pid: process.pid, id: 'foreign', expiresAt: Date.now() + 10_000 });
  for (const name of [`${anchor(lockPath)}.mutex`, `${anchor(lockPath)}.mutex.break`, join(anchor(lockPath), '.mutex'), join(anchor(lockPath), 'mutex'), join(anchor(lockPath), 'epoch-0.tmp')]) await writeFile(name, live);
  const t0 = performance.now();
  assert.equal(await h.refresh(), true, 'refresh does not involve any mutex');
  assert.equal(await h.refresh(), true);
  assert.ok(performance.now() - t0 < 1000);
  // A lower, foreign epoch file is not a reason to fail either.
  await plantEpoch(dir, h.epoch - 1, {});
  assert.equal(await h.refresh(), true);
}));

// L6
test('lock: refresh after own lease expiry reports lost', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const h = await acquireLock({ lockPath, owner: 'a', now: clock.now, ttlMs: 100 });
  assert.equal(await h.refresh(), true);
  const before = await readFile(join(anchor(lockPath), 'epoch-1'), 'utf8');
  clock.t += 100; // expiresAt <= now
  assert.equal(await h.refresh(), false);
  assert.equal(await readFile(join(anchor(lockPath), 'epoch-1'), 'utf8'), before, 'an expired lease is never revived');
  assert.equal(await h.refresh(), false, 'and stays lost');
  const b = await acquireLock({ lockPath, owner: 'b', now: clock.now, ttlMs: 100 });
  assert.equal(b.acquired, true);
}));

test('lock: refresh with a higher epoch present reports lost and leaves our file unchanged', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const h = await acquireLock({ lockPath, owner: 'a', now: clock.now, ttlMs: 100_000 });
  const before = await readFile(join(anchor(lockPath), 'epoch-1'), 'utf8');
  await plantEpoch(dir, 2, {});
  clock.t += 1; // a rewrite would change expiresAt
  assert.equal(await h.refresh(), false);
  assert.equal(await readFile(join(anchor(lockPath), 'epoch-1'), 'utf8'), before);
  // A higher epoch that appears during the write is caught by the check after it.
  let epoch2;
  const bLockPath = lockPathOf(dir, 'b.lock.d');
  const h2 = await acquireLock({ lockPath: bLockPath, owner: 'b', now: clock.now, ttlMs: 100_000, __hooks: { afterRefreshWrite: () => writeFile(join(anchor(bLockPath), `epoch-${epoch2 + 1}`), '{}') } });
  epoch2 = h2.epoch;
  assert.equal(await h2.refresh(), false);
}));

// L7
test('lock: dead-looking pid from a different host identity is not taken over before expiry', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  await plantEpoch(dir, 1, { hostId: 'other', pid: deadPid(), expiresAt: 5000 });
  const r = await acquireLock({ lockPath, owner: 'x', now: clock.now, ttlMs: 100 });
  assert.equal(r.acquired, false);
  assert.equal(r.reason, 'held');
  assert.deepEqual(await epochsOf(dir), [1]);
  clock.t = 5000; // lease over: now it is taken over, whatever the host
  const r2 = await acquireLock({ lockPath, owner: 'x', now: clock.now, ttlMs: 100 });
  assert.equal(r2.acquired, true);
  // Same host and a dead pid: taken over at once.
  const dir2 = await tmp();
  try {
    await plantEpoch(dir2, 1, { pid: deadPid(), expiresAt: 10 ** 12 });
    assert.equal((await acquireLock({ lockPath: lockPathOf(dir2), owner: 'x', now: clock.now, ttlMs: 100 })).acquired, true);
    // A record without any hostId is not known to be local either.
    await plantEpoch(dir2, 9, { hostId: undefined, pid: deadPid(), expiresAt: 10 ** 12 });
    assert.equal((await acquireLock({ lockPath: lockPathOf(dir2), owner: 'x', now: clock.now, ttlMs: 100 })).acquired, false);
    // The record we write carries a hash, never the host name.
    const rec = await readEpochFile(dir, 2);
    assert.equal(rec.hostId, hostId());
    assert.ok(!(await readFile(join(anchor(lockPath), 'epoch-2'), 'utf8')).includes(hostname()) || hostname().length < 4);
    assert.match(rec.hostId, /^[0-9a-f]{32}$/);
    assert.equal(rec.pid, process.pid);
  } finally { await rm(dir2, { recursive: true, force: true }); }
}));

// L8
test('lock: non-regular lock entries fail closed and fast', { timeout: 30000 }, withDir(async (dir) => {
  const outside = await tmp();
  try {
    const mkfifo = (p) => assert.equal(spawnSync('mkfifo', [p]).status, 0);
    const fast = async (p) => {
      const t0 = performance.now();
      const r = await acquireLock({ lockPath: p, owner: 'x' });
      assert.ok(performance.now() - t0 < 1000, 'settles within 1 s');
      assert.equal(r.acquired, false);
      assert.equal(typeof r.reason, 'string');
      return r;
    };
    // The anchored lock directory itself: a symlink to a directory holding a live-looking holder, a FIFO, a
    // huge file. The caller's path stays an ordinary work-root path; only the anchor holds the entries.
    const live = { owner: 'outside', pid: process.pid, hostId: hostId(), token: 'o', expiresAt: Date.now() + 1e9 };
    await mkdir(join(outside, 'target'));
    await writeFile(join(outside, 'target', 'epoch-7'), JSON.stringify(live));
    const plantAt = async (name, make) => {
      const target = anchor(lockPathOf(dir, name));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await make(target);
      return lockPathOf(dir, name);
    };
    const viaLink = await fast(await plantAt('link.lock.d', (p) => symlink(join(outside, 'target'), p)));
    assert.equal(viaLink.holder, null, 'nothing outside the root was read');
    assert.deepEqual(await readdir(join(outside, 'target')), ['epoch-7'], 'and nothing was written there');
    await fast(await plantAt('fifo.lock.d', (p) => mkfifo(p)));
    await fast(await plantAt('big.lock.d', async (p) => { await writeFile(p, ''); await truncate(p, 10 * 1024 * 1024); }));

    // An entry named like an epoch: symlink, FIFO, directory, 10 MiB file, 5 KiB file.
    const kinds = {
      symlink: (p) => symlink(join(outside, 'target', 'epoch-7'), p),
      fifo: async (p) => mkfifo(p),
      directory: (p) => mkdir(p),
      huge: async (p) => { await writeFile(p, ''); await truncate(p, 10 * 1024 * 1024); },
      overlarge: (p) => writeFile(p, JSON.stringify({ ...live, pad: 'x'.repeat(5000) })),
    };
    for (const [kind, make] of Object.entries(kinds)) {
      const lockPath = join(dir, `${kind}.entries.d`);
      await mkdir(anchor(lockPath), { recursive: true, mode: 0o700 });
      await make(join(anchor(lockPath), 'epoch-3'));
      const r = await fast(lockPath);
      assert.equal(r.reason, 'invalid_epoch_file', kind);
      assert.deepEqual((await readdir(anchor(lockPath))).filter((n) => n !== 'epoch-3'), [], `${kind}: nothing written next to it`);
    }
    assert.deepEqual(await readdir(join(outside, 'target')), ['epoch-7']);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

// L9
test('lock: all expiry decisions use the injected clock', withDir(async (dir) => {
  const clock = clockAt(10 ** 12);
  const lockPath = lockPathOf(dir);
  await plantEpoch(dir, 1, { expiresAt: 5000 }); // our own live pid, but the (injected) clock is far past its lease
  await writeFile(`${anchor(lockPath)}.mutex`, JSON.stringify({ pid: process.pid, id: 'x', expiresAt: 5000 }));
  const realNow = Date.now;
  Date.now = () => { throw new Error('Date.now must not be consulted'); };
  try {
    const h = await acquireLock({ lockPath, owner: 'a', now: clock.now, ttlMs: 1000 });
    assert.equal(h.acquired, true);
    assert.equal(await h.refresh(), true);
    clock.t += 2000;
    assert.equal(await h.refresh(), false);
    const h2 = await acquireLock({ lockPath, owner: 'b', now: clock.now, ttlMs: 1000 });
    assert.equal(h2.acquired, true);
    assert.equal(await h2.release(), true);
  } finally { Date.now = realNow; }
}));

// L10
test('lock: handle exposes a strictly increasing epoch across takeovers', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const h1 = await acquireLock({ lockPath, owner: 'a', now: clock.now, ttlMs: 100 });
  clock.t += 101;
  const h2 = await acquireLock({ lockPath, owner: 'b', now: clock.now, ttlMs: 100 });
  assert.ok(h2.epoch > h1.epoch);
  assert.equal(await h2.release(), true);
  const h3 = await acquireLock({ lockPath, owner: 'c', now: clock.now, ttlMs: 100 });
  assert.ok(h3.epoch > h2.epoch);
  assert.deepEqual([h1.epoch, h2.epoch, h3.epoch], [1, 2, 3]);
  assert.equal((await readEpochFile(dir, 3)).epoch, 3);
}));

// L11
test('lock: release reports whether the lock was released', withDir(async (dir) => {
  const lockPath = lockPathOf(dir);
  const a = await acquireLock({ lockPath, owner: 'a' }); // our own pid is alive and the lease is fresh
  assert.equal(await a.release(), true);
  assert.equal((await readEpochFile(dir, 1)).released, true);
  assert.equal(await a.release(), true, 'idempotent');
  assert.equal(await a.refresh(), false, 'a released handle cannot be refreshed');
  const b = await acquireLock({ lockPath, owner: 'b' });
  assert.equal(b.acquired, true, 'taken immediately although the first holder\'s pid is alive');
  assert.equal(b.epoch, 2);
  // Not released: our file is gone (or no longer ours).
  await rm(join(anchor(lockPath), 'epoch-2'));
  assert.equal(await b.release(), false);
  assert.equal(b.releaseReason, 'not_owner');
  const c = await acquireLock({ lockPath, owner: 'c' });
  await writeFile(join(anchor(lockPath), `epoch-${c.epoch}`), JSON.stringify({ token: 'someone else', pid: 1 }));
  assert.equal(await c.release(), false);
  assert.equal(c.releaseReason, 'not_owner');
  assert.equal(JSON.parse(await readFile(join(anchor(lockPath), `epoch-${c.epoch}`), 'utf8')).token, 'someone else', 'a file that is not ours is not rewritten');
}));

// L12
test('lock: leftover temp files never block acquire or refresh', withDir(async (dir) => {
  const lockPath = lockPathOf(dir);
  await mkdir(anchor(lockPath), { recursive: true, mode: 0o700 });
  const leftovers = ['.tmp-1', '.tmp-deadbeef', 'epoch-1.tmp', 'epoch-2.tmp', `epoch-1.${process.pid}.refresh`, 'epoch-2.stale'];
  for (const name of leftovers) await writeFile(join(anchor(lockPath), name), 'junk');
  for (const name of [`${anchor(lockPath)}.${process.pid}.tok.tmp`, `${anchor(lockPath)}.${process.pid}.tok.refresh`, `${anchor(lockPath)}.mutex.stale`]) await writeFile(name, 'junk');
  const h = await acquireLock({ lockPath, owner: 'a' });
  assert.equal(h.acquired, true);
  assert.equal(await h.refresh(), true);
  assert.equal(await h.release(), true);
  const h2 = await acquireLock({ lockPath, owner: 'b' });
  assert.equal(h2.acquired, true);
  for (const name of leftovers) assert.equal(await readFile(join(anchor(lockPath), name), 'utf8'), 'junk', `${name} untouched`);
  assert.equal(await h2.release(), true);
}));

test('lock: a write that fails mid-way leaves no temp file behind and the lock usable', withDir(async (dir) => {
  // Every write stores a few bytes and then fails (e.g. ENOSPC).
  let failing = true;
  const fs = { writeFile: async (p, content, opts) => { if (!failing) return realFs.writeFile(p, content, opts); await realFs.writeFile(p, String(content).slice(0, 5), opts); throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); } };
  const lockPath = lockPathOf(dir);
  await assert.rejects(acquireLock({ lockPath, owner: 'a', fs }), /no space/);
  assert.deepEqual(await readdir(anchor(lockPath)), [], 'the partial temp file was removed and no epoch was created');
  failing = false;
  const h = await acquireLock({ lockPath, owner: 'a', fs });
  assert.equal(h.acquired, true);
  const before = await readFile(join(anchor(lockPath), 'epoch-1'), 'utf8');
  failing = true;
  await assert.rejects(h.refresh(), /no space/);
  await assert.rejects(h.release(), /no space/);
  assert.deepEqual(await readdir(anchor(lockPath)), ['epoch-1']);
  assert.equal(await readFile(join(anchor(lockPath), 'epoch-1'), 'utf8'), before, 'a failed write leaves the lock file intact');
  failing = false;
  assert.equal(await h.refresh(), true);
  assert.equal(await h.release(), true);
}));

// L13
test('lock: lock files are created 0600', { skip: process.platform === 'win32' }, withDir(async (dir) => {
  const oldUmask = process.umask(0);
  try {
    const lockPath = lockPathOf(dir);
    const h = await acquireLock({ lockPath, owner: 'a' });
    const mode = async (p) => (await stat(p)).mode & 0o777;
    assert.equal(await mode(join(anchor(lockPath), 'epoch-1')), 0o600);
    assert.equal(await h.refresh(), true);
    assert.equal(await mode(join(anchor(lockPath), 'epoch-1')), 0o600);
    assert.equal(await h.release(), true);
    assert.equal(await mode(join(anchor(lockPath), 'epoch-1')), 0o600);
    assert.equal((await mode(anchor(lockPath))) & 0o077, 0, 'the lock directory is private');
  } finally { process.umask(oldUmask); }
}));

// L14
test('lock: link failure is surfaced, not degraded', withDir(async (dir) => {
  for (const code of ['ENOTSUP', 'EPERM']) {
    const lockPath = join(dir, `${code}.lock.d`);
    const fs = { link: async () => { throw Object.assign(new Error(`link: ${code}`), { code }); } };
    await assert.rejects(acquireLock({ lockPath, owner: 'a', fs }), (err) => err.code === code);
    assert.deepEqual(await readdir(anchor(lockPath)), [], 'no lock file and no temp file exists');
  }
}));


// ---------------------------------------------------------------------------------------------
// Anchored authority (issue #77): the work root is a hint, the private anchor is authoritative.

test('anchor: RTW_STATE_DIR is the anchor root, XDG_STATE_HOME gets /roundtable, no ~/.rtw fallback', () => {
  const home = join(tmpdir(), 'rt-fake-home');
  assert.equal(anchorRootOf({ env: { RTW_STATE_DIR: '/tmp/rtw-state' }, home }), '/tmp/rtw-state');
  assert.equal(anchorRootOf({ env: { XDG_STATE_HOME: '/tmp/xdg' }, home }), '/tmp/xdg/roundtable');
  assert.equal(anchorRootOf({ env: {}, home }), join(home, '.local', 'state', 'roundtable'));
  assert.ok(!anchorRootOf({ env: {}, home }).includes('.rtw'), 'no ~/.rtw fallback');
  assert.equal(anchorRootOf({ env: { RTW_STATE_DIR: '/tmp/a', XDG_STATE_HOME: '/tmp/xdg' }, home }), '/tmp/a');
});

test('anchor: a missing anchor is created 0700; locks/, the per-repo dir and the lock dir are private', withDir(async (dir) => {
  const anchorRoot = join(dir, 'state', 'anchor');
  const lockPath = lockPathOf(dir);
  const h = await acquireLock({ lockPath, repoRoot: dir, anchorRoot, owner: 'a' });
  assert.equal(h.acquired, true);
  const mode = async (p) => (await stat(p)).mode & 0o777;
  const repoDir = dirname(h.lockDirectory);
  assert.equal(await mode(anchorRoot), 0o700);
  assert.equal(await mode(join(anchorRoot, 'locks')), 0o700);
  assert.equal(await mode(repoDir), 0o700);
  assert.equal(await mode(h.lockDirectory), 0o700);
  assert.match(repoDir.slice(-64), /^[0-9a-f]{64}$/, 'the repo directory is a hash, never a user-controlled name');
  assert.equal(h.lockDirectory, lockDirectoryFor({ lockPath, repoRoot: dir, anchorRoot }), 'callers can compute the same path');
  assert.equal((await mode(join(anchorRoot, 'locks', `.repo-${repoDir.slice(-64)}.json`))) & 0o177, 0, 'the identity record is private');
  assert.equal(await h.release(), true);
}));

// Case 1
test('anchor: a symlinked anchor root is refused and nothing is written through the link', withDir(async (dir) => {
  const outside = await tmp();
  try {
    const linkAnchor = join(dir, 'state-link');
    await symlink(outside, linkAnchor);
    const r = await acquireLock({ lockPath: lockPathOf(dir), repoRoot: dir, anchorRoot: linkAnchor, owner: 'x' });
    assert.deepEqual([r.acquired, r.reason], [false, 'invalid_anchor']);
    assert.match(r.detail, /anchor:not_a_directory/);
    assert.deepEqual(await readdir(outside), [], 'no lock directory, no epoch and no identity file was created through the link');
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

// Case 2
test('anchor: an anchor owned by another uid is refused by the real ownership check', withDir(async (dir) => {
  const anchorRoot = join(dir, 'anchor');
  await mkdir(anchorRoot, { mode: 0o700 });
  const owner = (await stat(anchorRoot)).uid;
  // The test process cannot chown, so it injects the uid it claims to run as: lstat and the comparison stay real.
  const r = await acquireLock({ lockPath: lockPathOf(dir), repoRoot: dir, anchorRoot, owner: 'x', uid: owner + 1 });
  assert.deepEqual([r.acquired, r.reason], [false, 'invalid_anchor']);
  assert.match(r.detail, /anchor:wrong_owner/);
  assert.deepEqual(await readdir(anchorRoot), []);
}));

test('anchor: a group/world accessible anchor is refused, not silently chmod-ed', withDir(async (dir) => {
  const anchorRoot = join(dir, 'anchor');
  await mkdir(anchorRoot, { mode: 0o700 });
  await chmod(anchorRoot, 0o755);
  const r = await acquireLock({ lockPath: lockPathOf(dir), repoRoot: dir, anchorRoot, owner: 'x' });
  assert.deepEqual([r.acquired, r.reason], [false, 'invalid_anchor']);
  assert.match(r.detail, /anchor:insecure_mode/);
  assert.equal((await stat(anchorRoot)).mode & 0o777, 0o755, 'the anchor is left as found');
  assert.deepEqual(await readdir(anchorRoot), []);
}));

// Case 3
test('anchor: a record swapped between the identity check and the rewrite is lost (dev+ino), never rewritten', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const anchored = anchor(lockPath);
  let swap = true;
  const h = await acquireLock({ lockPath, owner: 'a', now: clock.now, ttlMs: 10_000, __hooks: { beforeRefreshWrite: async () => {
    if (!swap) return;
    swap = false;
    // Same epoch, same token, same bytes: only the inode differs.
    const copy = join(anchored, '.swapped');
    await writeFile(copy, await readFile(join(anchored, 'epoch-1'), 'utf8'));
    await realFs.rename(copy, join(anchored, 'epoch-1'));
  } } });
  assert.equal(h.acquired, true);
  assert.equal(await h.refresh(), false, 'the rewrite detected the swapped record and reported the lease lost');
  assert.equal(await h.release(), false);
  assert.equal(h.releaseReason, 'not_owner');
  // The swapped-in record keeps the same live lease for everybody else: it is not a second valid holder,
  // and it is never reused as the next holder's record either.
  const held = await acquireLock({ lockPath, owner: 'b', now: clock.now, ttlMs: 10_000 });
  assert.deepEqual([held.acquired, held.reason], [false, 'held']);
  clock.t += 10_001;
  const next = await acquireLock({ lockPath, owner: 'c', now: clock.now, ttlMs: 10_000 });
  assert.equal(next.acquired, true);
  assert.equal(next.epoch, 2, 'a new epoch file is created; the swapped record is never handed out');
  assert.equal(await h.refresh(), false);
  assert.equal(await next.release(), true);
}));

test('anchor: release of a replaced record fails closed and leaves the replacement untouched', withDir(async (dir) => {
  const lockPath = lockPathOf(dir);
  const anchored = anchor(lockPath);
  const h = await acquireLock({ lockPath, owner: 'a' });
  const copy = join(anchored, '.swapped');
  await writeFile(copy, await readFile(join(anchored, 'epoch-1'), 'utf8'));
  await realFs.rename(copy, join(anchored, 'epoch-1'));
  const bytes = await readFile(join(anchored, 'epoch-1'), 'utf8');
  assert.equal(await h.release(), false);
  assert.equal(h.releaseReason, 'not_owner');
  assert.equal(await readFile(join(anchored, 'epoch-1'), 'utf8'), bytes);
}));

// Case 5
test('anchor: replacing the per-repo anchor directory invalidates the handle and refuses new holders', withDir(async (dir) => {
  const anchorRoot = join(dir, 'anchor');
  const lockPath = lockPathOf(dir);
  const h = await acquireLock({ lockPath, repoRoot: dir, anchorRoot, owner: 'a' });
  const repoDir = dirname(h.lockDirectory);
  await realFs.rename(repoDir, `${repoDir}.saved`);
  await mkdir(repoDir, { mode: 0o700 });
  assert.equal(await h.refresh(), false, 'renew after the anchored directory was replaced fails closed');
  assert.equal(await h.release(), false);
  assert.equal(h.releaseReason, 'lock_lost');
  await assert.rejects(h.anchorHighWater(), { code: 'RT_LOCK_LOST' });
  const replacement = await acquireLock({ lockPath, repoRoot: dir, anchorRoot, owner: 'b' });
  assert.deepEqual([replacement.acquired, replacement.reason], [false, 'invalid_anchor']);
  assert.match(replacement.detail, /repo:id_changed/, 'the recorded directory inode no longer matches');
  assert.deepEqual(await readdir(repoDir), [], 'nothing was written into the replacement');
}));

test('anchor: emptying the anchored lock directory invalidates the holder instead of resetting its lease', withDir(async (dir) => {
  const anchorRoot = join(dir, 'anchor');
  const lockPath = lockPathOf(dir);
  const h = await acquireLock({ lockPath, repoRoot: dir, anchorRoot, owner: 'a' });
  await rm(h.lockDirectory, { recursive: true, force: true });
  assert.equal(await h.refresh(), false);
  assert.equal(await h.release(), false);
  await assert.rejects(h.anchorHighWater(), { code: 'RT_LOCK_LOST' });
}));

// Case 6
test('anchor: in-repo lock-directory churn can neither validate an older holder nor reset the fencing token', withDir(async (dir) => {
  const clock = clockAt(1000);
  const lockPath = lockPathOf(dir);
  const anchored = anchor(lockPath);
  const live = JSON.stringify({ owner: 'forged', pid: process.pid, hostId: hostId(), token: 'forged', expiresAt: 10 ** 13 });
  const h = await acquireLock({ lockPath, owner: 'a', now: clock.now, ttlMs: 100 });
  // The work root (including the old in-repo lock path) is churned: replaced, filled with a forged record, emptied.
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'epoch-99'), live);
  await rm(lockPath, { recursive: true, force: true });
  assert.equal(await h.refresh(), true, 'the work root is not authoritative in either direction');
  clock.t += 101;
  const next = await acquireLock({ lockPath, owner: 'b', now: clock.now, ttlMs: 100 });
  assert.equal(next.acquired, true);
  assert.equal(next.epoch, h.epoch + 1, 'epochs continue above the anchor high-water mark, never below it');
  assert.equal(await h.refresh(), false, 'an older holder is never valid next to a new one');
  assert.equal(await h.anchorHighWater(), next.epoch);
  assert.deepEqual(await readdir(anchored), ['epoch-1', 'epoch-2'], 'both records live in the anchor, not in the work root');
  await next.release();
}));

// Issue #140: the anchor is chosen by the environment, so one work root must not be shared by two anchor domains.
test('anchor: a work root bound to one anchor refuses another anchor, both while held and after release', withDir(async (dir) => {
  const other = await tmp();
  try {
    const lockPath = lockPathOf(dir);
    const markerPath = join(dir, '.roundtable', 'lock-domain');
    const a = await acquireLock({ lockPath, repoRoot: dir, anchorRoot: ANCHOR, owner: 'a' });
    assert.equal(a.acquired, true);
    const marker = await readFile(markerPath, 'utf8');
    const refused = () => acquireLock({ lockPath, repoRoot: dir, anchorRoot: other, owner: 'x' });
    const held = await refused();
    assert.deepEqual([held.acquired, held.reason], [false, 'anchor_mismatch']);
    assert.equal(await a.refresh(), true, 'the refusal does not disturb the holder');
    assert.equal(await a.release(), true);
    // Still refused with no lease left: the refusal is about the domain, not about who holds the lock.
    const released = await refused();
    assert.deepEqual([released.acquired, released.reason], [false, 'anchor_mismatch']);
    assert.deepEqual((await readdir(lockDirectoryFor({ lockPath, repoRoot: dir, anchorRoot: other }))).filter((n) => /^epoch-\d+$/.test(n)), [], 'the refused invocation created no epoch under the other anchor');
    assert.equal(await readFile(markerPath, 'utf8'), marker, 'the marker is written once and never rewritten');
    const again = await acquireLock({ lockPath, repoRoot: dir, anchorRoot: ANCHOR, owner: 'b' });
    assert.equal(again.acquired, true, 'the bound anchor keeps working');
    assert.equal(again.epoch, 2);
    assert.equal(await again.release(), true);
  } finally { await rm(other, { recursive: true, force: true }); }
}));

test('anchor: a symlinked or corrupt domain marker fails closed and is never used to choose an anchor', withDir(async (dir) => {
  const outside = await tmp();
  try {
    const lockPath = lockPathOf(dir);
    const markerDir = join(dir, '.roundtable');
    const reason = async () => {
      const r = await acquireLock({ lockPath, repoRoot: dir, owner: 'x' });
      assert.equal(r.acquired, false);
      return r.reason;
    };
    // The marker's directory is a symlink: refused, nothing written through it.
    await mkdir(join(outside, 'state'), { mode: 0o700 });
    await symlink(join(outside, 'state'), markerDir);
    assert.equal(await reason(), 'invalid_lock_domain');
    assert.deepEqual(await readdir(join(outside, 'state')), []);
    // The marker itself is a symlink: refused without following it, the target is untouched.
    await rm(markerDir);
    await mkdir(markerDir, { mode: 0o700 });
    await writeFile(join(outside, 'sentinel'), 'do not touch');
    await symlink(join(outside, 'sentinel'), join(markerDir, 'lock-domain'));
    assert.equal(await reason(), 'invalid_lock_domain');
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'do not touch');
    // Corrupt, foreign or unknown-version content is refused, never resolved as a lock location.
    await rm(join(markerDir, 'lock-domain'));
    const bodies = ['{"version":1,"anchor":', JSON.stringify({ version: 1, anchor: join(outside, 'state') }), JSON.stringify({ version: 2, anchor: 'a'.repeat(64) })];
    for (const body of bodies) {
      await writeFile(join(markerDir, 'lock-domain'), body);
      assert.equal(await reason(), 'invalid_lock_domain', body);
    }
    assert.deepEqual(await readdir(join(outside, 'state')), [], 'nothing was written through the marker');
  } finally { await rm(outside, { recursive: true, force: true }); }
}));
