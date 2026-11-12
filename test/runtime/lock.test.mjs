import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquireLock } from '../../runtime/lib/lock.mjs';

// RT_LOCK_MODULE lets a reviewer point the child processes at another implementation (e.g. to show
// that the test fails against an older lock); by default the real module is used.
const LOCK_MODULE = process.env.RT_LOCK_MODULE
  ? pathToFileURL(process.env.RT_LOCK_MODULE).href
  : new URL('../../runtime/lib/lock.mjs', import.meta.url).href;
const tmp = () => mkdtemp(join(tmpdir(), 'rt-lock-'));
const exists = (p) => access(p).then(() => true, () => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONTENDER = `
import { appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const { acquireLock } = await import(process.env.RT_LOCK_MODULE_URL);
const dir = process.env.RT_DIR;
const name = process.env.RT_NAME;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
writeFileSync(join(dir, 'ready.' + name), '');
while (!existsSync(join(dir, 'start'))) await sleep(1);
const lock = await acquireLock({ lockPath: join(dir, 'rtd.lock'), owner: name, ttlMs: 60000 });
if (lock.acquired) {
  appendFileSync(join(dir, 'events.log'), JSON.stringify({ name, ev: 'acquire', t: process.hrtime.bigint().toString() }) + '\\n');
  await sleep(80);
  appendFileSync(join(dir, 'events.log'), JSON.stringify({ name, ev: 'release', t: process.hrtime.bigint().toString() }) + '\\n');
  await lock.release();
}
`;

function runChild(script, env) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ...env }, stdio: 'ignore' });
  return new Promise((resolve) => child.on('close', resolve));
}

async function waitForFiles(paths) {
  for (let i = 0; i < 1000; i++) {
    if ((await Promise.all(paths.map(exists))).every(Boolean)) return;
    await sleep(5);
  }
  throw new Error('timed out waiting for contenders');
}

test('stale takeover is mutually exclusive across real processes: one winner per round, never two holders', { timeout: 60000 }, async () => {
  const dead = spawnSync(process.execPath, ['-e', '']);
  assert.equal(dead.status, 0);
  const PROCS = 6;
  const ROUNDS = 12;
  for (let round = 0; round < ROUNDS; round++) {
    const dir = await tmp();
    try {
      // An already-stale lock: its owner process is gone.
      await writeFile(join(dir, 'rtd.lock'), JSON.stringify({ owner: 'old', pid: dead.pid, token: 'old', acquiredAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
      const names = Array.from({ length: PROCS }, (_, i) => `p${i}`);
      const done = names.map((name) => runChild(CONTENDER, { RT_DIR: dir, RT_NAME: name, RT_LOCK_MODULE_URL: LOCK_MODULE }));
      await waitForFiles(names.map((n) => join(dir, `ready.${n}`)));
      await writeFile(join(dir, 'start'), '');
      assert.deepEqual(await Promise.all(done), names.map(() => 0));

      const events = (await readFile(join(dir, 'events.log'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
      const acquires = events.filter((e) => e.ev === 'acquire');
      assert.equal(acquires.length, 1, `round ${round}: expected exactly one winner, got ${acquires.map((a) => a.name)}`);
      // Interval check: no two holds overlap.
      let holders = 0;
      for (const e of events.sort((a, b) => (BigInt(a.t) < BigInt(b.t) ? -1 : 1))) {
        holders += e.ev === 'acquire' ? 1 : -1;
        assert.ok(holders <= 1, `round ${round}: two holders at once`);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('stale takeover: in-process contenders racing for an expired lock yield exactly one holder', async () => {
  const dir = await tmp();
  try {
    const clock = { t: 1000 };
    const lockPath = join(dir, 'rtd.lock');
    const first = await acquireLock({ lockPath, owner: 'first', now: () => clock.t, ttlMs: 100 });
    assert.equal(first.acquired, true);
    clock.t += 101;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireLock({ lockPath, owner: `c${i}`, now: () => clock.t, ttlMs: 100 })));
    assert.equal(results.filter((r) => r.acquired).length, 1);
    const winner = results.find((r) => r.acquired);
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, winner.token);
    assert.equal(await first.refresh(), false);
    assert.equal(await winner.refresh(), true);
    await winner.release();
    assert.equal(await exists(lockPath), false);
    assert.equal(await exists(`${lockPath}.mutex`), false, 'the takeover mutex is released');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a displaced holder cannot refresh over or release its successor\'s lock', async () => {
  const dir = await tmp();
  try {
    const clock = { t: 1000 };
    const lockPath = join(dir, 'rtd.lock');
    const a = await acquireLock({ lockPath, owner: 'a', now: () => clock.t, ttlMs: 100 });
    clock.t += 101;
    const b = await acquireLock({ lockPath, owner: 'b', now: () => clock.t, ttlMs: 100 });
    assert.equal(b.acquired, true);
    assert.equal(await a.refresh(), false);
    await a.release();
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, b.token);
    assert.equal(await b.refresh(), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a takeover mutex left behind by a dead process does not block takeover', async () => {
  const dir = await tmp();
  try {
    const dead = spawnSync(process.execPath, ['-e', '']);
    const lockPath = join(dir, 'rtd.lock');
    const old = JSON.stringify({ owner: 'old', pid: dead.pid, token: 'old', acquiredAt: 1, expiresAt: Date.now() + 3_600_000 });
    await writeFile(lockPath, old);
    await writeFile(`${lockPath}.mutex`, JSON.stringify({ pid: dead.pid, id: 'x', expiresAt: Date.now() + 3_600_000 }));
    const lock = await acquireLock({ lockPath, owner: 'new' });
    assert.equal(lock.acquired, true);
    await lock.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a live holder with a fresh lease is never taken over, and its lock file is left untouched', async () => {
  const dir = await tmp();
  try {
    const lockPath = join(dir, 'rtd.lock');
    const a = await acquireLock({ lockPath, owner: 'a' });
    const before = await readFile(lockPath, 'utf8');
    const results = await Promise.all(Array.from({ length: 6 }, () => acquireLock({ lockPath, owner: 'x' })));
    assert.deepEqual(results.map((r) => r.acquired), Array(6).fill(false));
    assert.equal(await readFile(lockPath, 'utf8'), before);
    await a.release();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
