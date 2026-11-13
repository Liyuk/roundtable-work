import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQueue, exitCodeFor, EXIT_LOCKED, EXIT_LOCK_LOST } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { acquireLock, lockDirectoryFor } from '../../runtime/lib/lock.mjs';

const RTD = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'rt-renewal-'));
// Runtime lock records live in the private anchor (RTW_STATE_DIR, inherited by child processes), never in the
// work root: `.roundtable/state/rtd.lock.d` is only the caller-side path whose last component names the lock.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-renewal-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* leaving /tmp behind is harmless */ } });
const lockPathOf = (root) => join(root, '.roundtable', 'state', 'rtd.lock.d');
const lockDirOf = (root) => lockDirectoryFor({ lockPath: lockPathOf(root), repoRoot: root, anchorRoot: ANCHOR });
const epochsIn = (root) => readdirSync(lockDirOf(root)).map((n) => /^epoch-(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
const plantEpoch = (root, rec) => writeFileSync(join(lockDirOf(root), `epoch-${Math.max(0, ...epochsIn(root)) + 1}`), JSON.stringify(rec));
const topHolder = (root) => JSON.parse(readFileSync(join(lockDirOf(root), `epoch-${Math.max(...epochsIn(root))}`), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PASS = '审查结论：通过\nok';

// Generous margins: the lease is 600 ms, renewed every 200 ms; the quiet handler runs 1800 ms (3x the lease).
const TTL = 600;
const RENEW = { lockTtlMs: TTL, lockRenewMinMs: 20 };

test('a quiet handler (no heartbeat) longer than 2x the lock TTL keeps the lock: a second acquireLock and runQueue are refused', async () => {
  const root = await tmp();
  try {
    const lockPath = lockPathOf(root);
    const attempts = [];
    const phases = [];
    let secondRuns = 0;
    const handler = async ({ phase }) => {
      phases.push(phase);
      if (phase === 'developing') {
        const end = Date.now() + 3 * TTL;
        while (Date.now() < end) {
          await sleep(150);
          const other = await acquireLock({ lockPath, repoRoot: root, owner: 'intruder', ttlMs: TTL });
          const second = await runQueue({ workRoot: root, queue: ['1'], handler: async () => { secondRuns++; return { exitCode: 0 }; }, ...RENEW });
          attempts.push({ acquired: other.acquired, status: second.status });
          if (other.acquired) await other.release();
        }
      }
      return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' };
    };
    const result = await runQueue({ workRoot: root, queue: ['1'], handler, ...RENEW });
    assert.equal(result.status, 'ok');
    assert.equal(result.outcomes[0].status, 'done');
    assert.ok(attempts.length >= 5, `probed ${attempts.length} times`);
    assert.ok(attempts.every((a) => a.acquired === false && a.status === 'locked'), JSON.stringify(attempts));
    assert.equal(secondRuns, 0);
    assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lock lost during a quiet handler: the signal aborts, the wake ends lock_lost, nothing is recorded or checkpointed', async () => {
  const root = await tmp();
  try {
    const phases = [];
    let signalAborted = false;
    let planted = false;
    let lateRecord = 'not attempted';
    const handler = async ({ item, phase, signal, recordArtifacts }) => {
      phases.push(`${item.id}:${phase}`);
      // Another process takes the lock over (writes a higher epoch file), while this handler stays quiet.
      if (!planted) { planted = true; plantEpoch(root, { owner: 'thief', pid: process.pid, token: 'thief-token', acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 }); }
      await new Promise((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', resolve, { once: true });
        setTimeout(resolve, 5000); // safety net: the test fails below if the signal never fired
      });
      signalAborted = signal.aborted;
      lateRecord = await recordArtifacts({ output: 'out/late.txt' }).then(() => 'recorded', () => 'rejected');
      return { exitCode: 0, output: 'ok', changedFiles: 1, artifacts: { output: 'out/returned.txt' } };
    };
    const result = await runQueue({ workRoot: root, queue: ['5', '6'], handler, ...RENEW });
    assert.equal(signalAborted, true, 'the handler signal was aborted by the lock loss');
    assert.equal(lateRecord, 'rejected');
    assert.equal(result.status, 'lock_lost');
    assert.deepEqual(phases, ['5:developing'], 'no further phase or issue runs');
    assert.deepEqual([result.outcomes[0].status, result.outcomes[0].decision], ['lock_lost', 'wait']);
    assert.equal(topHolder(root).token, 'thief-token', 'the other lock is untouched');
    const store = await createStateStore({ workRoot: root });
    const state = await store.load('5');
    assert.equal(state.checkpoint, null);
    assert.equal(state.artifacts.output, undefined);
    // Old behaviour (lease released after the loss) was dropped on purpose: after a lost lock nothing is written.
    assert.ok(state.lease?.owner.startsWith(`rtd-${process.pid}-`), 'the lease is left as it was and expires on its own');
    assert.equal((await store.load('6')).attempts.wakes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exitCodeFor maps ok to 0, locked to 75 and lock_lost to 76', () => {
  assert.equal(EXIT_LOCKED, 75);
  assert.equal(EXIT_LOCK_LOST, 76);
  assert.equal(exitCodeFor({ status: 'ok', outcomes: [], skipped: [] }), 0);
  assert.equal(exitCodeFor({ status: 'locked', holder: {} }), 75);
  assert.equal(exitCodeFor({ status: 'lock_lost', outcomes: [], skipped: [] }), 76);
  assert.notEqual(exitCodeFor({ status: 'lock_lost' }), 0);
});

test('the CLI process exits 76 on lock_lost, 75 on locked and 0 on ok', { timeout: 30000 }, async () => {
  const root = await tmp();
  try {
    await writeFile(join(root, 'queue.json'), JSON.stringify([{ id: '1' }]));
    await writeFile(join(root, 'handler.mjs'), `
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default async function ({ phase }) {
  if (process.env.RT_TEST_MODE === 'steal') {
    // A successor takes the lock over: it writes the next epoch file.
    const dir = process.env.RT_TEST_LOCK_DIR;
    const next = Math.max(0, ...readdirSync(dir).map((n) => /^epoch-(\\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number)) + 1;
    writeFileSync(join(dir, 'epoch-' + next), JSON.stringify({ owner: 'thief', pid: process.pid, token: 't', acquiredAt: Date.now(), expiresAt: Date.now() + 60000 }));
  }
  return { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过\\nok' : 'ok' };
}
`);
    const cli = (mode) => new Promise((resolve) => {
      const child = spawn(process.execPath, [RTD, '--work-root', root, '--queue', 'queue.json', '--handler', join(root, 'handler.mjs')],
        { env: { ...process.env, RT_TEST_ROOT: root, RT_TEST_LOCK_DIR: lockDirOf(root), RT_TEST_MODE: mode }, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    const lost = await cli('steal');
    assert.equal(lost.code, EXIT_LOCK_LOST);
    assert.equal(JSON.parse(lost.out).status, 'lock_lost');
    await rm(lockDirOf(root), { recursive: true, force: true });
    const held = await acquireLock({ lockPath: lockPathOf(root), repoRoot: root, owner: 'someone' });
    assert.equal(held.acquired, true);
    const locked = await cli('plain');
    assert.equal(locked.code, EXIT_LOCKED);
    assert.equal(JSON.parse(locked.out).status, 'locked');
    await held.release();
    const ok = await cli('plain');
    assert.equal(ok.code, 0);
    assert.equal(JSON.parse(ok.out).status, 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bad lock timing is rejected up front with a TypeError; valid and default timing is accepted', async () => {
  const root = await tmp();
  try {
    const handler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' });
    const bad = [
      { lockTtlMs: 100, lockRenewMinMs: 1000 }, // expires before the first renewal
      { lockTtlMs: 1000, lockRenewMinMs: 1000 },
      { lockTtlMs: 1000, lockRenewMinMs: 501 }, // more than half a lease
      { lockTtlMs: 1000, lockRenewMinMs: 0 },
      { lockTtlMs: 1000, lockRenewMinMs: -5 },
      { lockTtlMs: 0, lockRenewMinMs: 1 },
      { lockTtlMs: Number.NaN, lockRenewMinMs: 1 },
      { lockTtlMs: 1000, lockRenewMinMs: '10' },
      { lockTtlMs: Infinity, lockRenewMinMs: 10 },
    ];
    for (const opts of bad) {
      await assert.rejects(runQueue({ workRoot: root, queue: ['1'], handler, ...opts }), TypeError, JSON.stringify(opts));
    }
    // Rejected before anything ran: no lock file, no state.
    await assert.rejects(readFile(join(lockDirOf(root), 'epoch-1')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(root, 'state', '1.json')), { code: 'ENOENT' });
    // Exactly half a lease, and the defaults, are valid.
    assert.equal((await runQueue({ workRoot: root, queue: ['1'], handler, lockTtlMs: 1000, lockRenewMinMs: 500 })).status, 'ok');
    assert.equal((await runQueue({ workRoot: root, queue: ['2'], handler })).status, 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('after a lost lock the successor\'s lease, checkpoint, artifacts and state file are not written to', async () => {
  const root = await tmp();
  try {
    const store = await createStateStore({ workRoot: root });
    store.setEpoch(2);
    let before;
    const handler = async ({ signal }) => {
      // The successor takes the lock and the issue state while this handler is still running.
      plantEpoch(root, { owner: 'successor', pid: process.pid, token: 'succ', acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 });
      await store.update('7', (s) => {
        s.lease = { owner: 'rtd-successor', expiresAt: Date.now() + 60_000 };
        s.checkpoint = { phase: 'testing', at: 1 };
        s.artifacts = { output: 'out/successor.txt' };
      });
      before = { raw: await readFile(join(root, 'state', '~37.epoch-2.json'), 'utf8'), ino: (await stat(join(root, 'state', '~37.epoch-2.json'))).ino };
      await new Promise((resolve) => { if (signal.aborted) return resolve(); signal.addEventListener('abort', resolve, { once: true }); setTimeout(resolve, 5000); });
      return { exitCode: 0, output: 'ok', artifacts: { output: 'out/ours.txt' } };
    };
    const result = await runQueue({ workRoot: root, queue: ['7'], handler, ...RENEW });
    assert.equal(result.status, 'lock_lost');
    const file = join(root, 'state', '~37.epoch-2.json');
    assert.equal(await readFile(file, 'utf8'), before.raw, 'the successor\'s state is byte-for-byte unchanged');
    assert.equal((await stat(file)).ino, before.ino, 'the state file was not rewritten at all');
    const state = await store.load('7');
    assert.deepEqual([state.lease.owner, state.checkpoint.phase, state.artifacts.output], ['rtd-successor', 'testing', 'out/successor.txt']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
