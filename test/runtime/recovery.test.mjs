import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQueue, EXIT_LOCKED } from '../../runtime/rtd.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { acquireLock } from '../../runtime/lib/lock.mjs';

const RTD = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'rt-recovery-'));
const exists = (p) => access(p).then(() => true, () => false);
const PASS = '审查结论：通过\nok';

// Fixture files standing in for a worktree, a diff and model output.
async function writeFixtures(root, id) {
  const files = { worktree: `worktrees/${id}/src.txt`, diff: `out/${id}.diff`, output: `out/${id}.txt` };
  await mkdir(join(root, 'worktrees', id), { recursive: true });
  await mkdir(join(root, 'out'), { recursive: true });
  await writeFile(join(root, files.worktree), 'work in progress');
  await writeFile(join(root, files.diff), '+ change');
  await writeFile(join(root, files.output), 'model output');
  return files;
}
async function assertFixturesIntact(root, files) {
  assert.equal(await readFile(join(root, files.worktree), 'utf8'), 'work in progress');
  assert.equal(await readFile(join(root, files.diff), 'utf8'), '+ change');
  assert.equal(await readFile(join(root, files.output), 'utf8'), 'model output');
}

const HANDLER_SOURCE = `
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.RT_TEST_ROOT;
const mode = process.env.RT_TEST_MODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default async function handler({ item, phase }) {
  if (mode === 'hold') {
    writeFileSync(join(root, 'started'), String(process.pid));
    const deadline = Date.now() + 15000;
    while (!existsSync(join(root, 'release')) && Date.now() < deadline) await sleep(20);
  }
  if (mode === 'crash') {
    if (phase === 'developing') {
      mkdirSync(join(root, 'out'), { recursive: true });
      writeFileSync(join(root, 'out', item.id + '.txt'), 'model output');
      return { exitCode: 0, output: 'ok', changedFiles: 2, artifacts: { output: 'out/' + item.id + '.txt' } };
    }
    if (phase === 'testing') process.exit(137);
  }
  return { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过\\nok' : 'ok' };
}
`;

async function cliSetup(mode) {
  const root = await tmp();
  await writeFile(join(root, 'queue.json'), JSON.stringify([{ id: '49' }]));
  await writeFile(join(root, 'handler.mjs'), HANDLER_SOURCE);
  const children = [];
  const run = () => {
    const child = spawn(process.execPath, [RTD, '--work-root', root, '--queue', 'queue.json', '--handler', join(root, 'handler.mjs')],
      { env: { ...process.env, RT_TEST_ROOT: root, RT_TEST_MODE: mode }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  };
  const cleanup = async () => { for (const c of children) c.kill('SIGKILL'); await rm(root, { recursive: true, force: true }); };
  const exit = (child) => new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
  return { root, run, exit, cleanup };
}

async function waitFor(path) {
  for (let i = 0; i < 500; i++) { if (await exists(path)) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error(`timed out waiting for ${path}`);
}

test('single-flight: a second real process cannot run the same queue while the first is running', { timeout: 20000 }, async () => {
  const { root, run, exit, cleanup } = await cliSetup('hold');
  try {
    const first = run();
    const firstDone = exit(first);
    await waitFor(join(root, 'started'));
    const second = await exit(run());
    assert.equal(second.code, EXIT_LOCKED);
    assert.equal(JSON.parse(second.out).status, 'locked');
    assert.equal(JSON.parse(second.out).holder.pid, first.pid);
    await writeFile(join(root, 'release'), '');
    const result = await firstDone;
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.out).outcomes[0].status, 'done');
    assert.equal(await exists(join(root, 'rtd.lock')), false, 'lock is released on exit');
  } finally { await cleanup(); }
});

test('single-flight: a locked run reports the holder, runs nothing and leaves the holder\'s lock in place', { timeout: 20000 }, async () => {
  const root = await tmp();
  try {
    const holder = await acquireLock({ lockPath: join(root, 'rtd.lock'), owner: 'other' });
    assert.equal(holder.acquired, true);
    let calls = 0;
    const result = await runQueue({ workRoot: root, queue: ['1'], handler: async () => { calls++; return {}; } });
    assert.equal(result.status, 'locked');
    assert.equal(result.holder.owner, 'other');
    assert.equal(calls, 0);
    assert.equal(await exists(join(root, 'rtd.lock')), true, 'a run that never got the lock must not release it');
    assert.equal((await readFile(join(root, 'rtd.lock'), 'utf8')).includes(holder.token), true);
    await holder.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('single-flight: a lock whose process died is stale and is taken over', { timeout: 20000 }, async () => {
  const root = await tmp();
  try {
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    await writeFile(join(root, 'rtd.lock'), JSON.stringify({ owner: 'old', pid: dead.pid, token: 'x', acquiredAt: Date.now(), expiresAt: Date.now() + 3_600_000 }));
    const result = await runQueue({ workRoot: root, queue: ['1'], handler: async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' }) });
    assert.equal(result.status, 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('single-flight: a live holder with an expired lock lease is stale; with a fresh lease it is not', async () => {
  const root = await tmp();
  try {
    const clock = { t: 10_000 };
    const lockPath = join(root, 'rtd.lock');
    const a = await acquireLock({ lockPath, owner: 'a', now: () => clock.t, ttlMs: 1000 });
    assert.equal(a.acquired, true);
    assert.equal((await acquireLock({ lockPath, owner: 'b', now: () => clock.t, ttlMs: 1000 })).acquired, false);
    clock.t += 1001;
    const b = await acquireLock({ lockPath, owner: 'b', now: () => clock.t, ttlMs: 1000 });
    assert.equal(b.acquired, true);
    assert.equal(await a.refresh(), false, 'the displaced owner can no longer refresh');
    await a.release(); // must not remove b's lock
    assert.equal(await exists(lockPath), true);
    await b.release();
    assert.equal(await exists(lockPath), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('crash mid-issue: restart resumes from the checkpoint and keeps artifacts', { timeout: 20000 }, async () => {
  const { root, run, exit, cleanup } = await cliSetup('crash');
  try {
    const files = await writeFixtures(root, '49');
    const crashed = await exit(run());
    assert.equal(crashed.code, 137);
    const store = await createStateStore({ workRoot: root });
    const mid = await store.load('49');
    assert.equal(mid.status, 'working');
    assert.equal(mid.phase, 'testing');
    assert.equal(mid.checkpoint.phase, 'developing');
    assert.equal(mid.artifacts.output, 'out/49.txt');
    assert.equal(mid.changedFiles, 2);
    await assertFixturesIntact(root, files);

    const phases = [];
    const result = await runQueue({
      workRoot: root, queue: 'queue.json', now: () => Date.now() + 3_600_000,
      handler: async ({ phase }) => { phases.push(phase); return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' }; },
    });
    assert.deepEqual(phases, ['testing', 'reviewing', 'finalizing'], 'developing is not redone');
    assert.equal(result.outcomes[0].status, 'done');
    const end = await store.load('49');
    assert.equal(end.recovery.interruptedPhase, 'testing');
    assert.equal(end.recovery.resumePhase, 'testing');
    assert.equal(end.recovery.lastCheckpoint, 'developing');
    assert.equal(end.recovery.artifacts.output, 'out/49.txt');
    await assertFixturesIntact(root, files);
  } finally { await cleanup(); }
});

test('recovery without any checkpoint restarts at developing and still keeps recorded artifacts', async () => {
  const root = await tmp();
  try {
    const files = await writeFixtures(root, '5');
    const clock = { t: 1000 };
    const store = await createStateStore({ workRoot: root, now: () => clock.t });
    await store.acquireLease('5', 'dead');
    await store.beginPhase('5', 'developing');
    await store.recordArtifacts('5', files);
    clock.t += 10 * 60_000;
    const rec = await store.recover('5');
    assert.equal(rec.action, 'resume');
    assert.equal(rec.resumePhase, 'developing');
    assert.equal(rec.state.lease, null);
    assert.deepEqual(rec.state.artifacts, files);
    await assertFixturesIntact(root, files);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a crash inside a side-effecting phase records a precise recoverable terminal state, not a re-run', async () => {
  const root = await tmp();
  try {
    const files = await writeFixtures(root, '6');
    const clock = { t: 1000 };
    const store = await createStateStore({ workRoot: root, now: () => clock.t });
    await store.acquireLease('6', 'dead');
    await store.recordArtifacts('6', files);
    await store.checkpoint('6', 'reviewing');
    await store.beginPhase('6', 'finalizing');
    clock.t += 10 * 60_000;
    const calls = [];
    const result = await runQueue({ workRoot: root, queue: ['6'], now: () => clock.t, handler: async ({ phase }) => { calls.push(phase); return { exitCode: 0, output: 'ok' }; } });
    assert.deepEqual(calls, []);
    assert.equal(result.outcomes[0].status, 'interrupted');
    const s = await store.load('6');
    assert.equal(s.status, 'interrupted');
    assert.equal(s.recovery.interruptedPhase, 'finalizing');
    assert.equal(s.recovery.lastCheckpoint, 'reviewing');
    assert.equal(s.recovery.leaseExpired, true);
    // The loop does not pick it up again on its own.
    const again = await runQueue({ workRoot: root, queue: [{ id: '6', state: 'queued' }], now: () => clock.t, handler: async () => { calls.push('again'); return {}; } });
    assert.deepEqual(calls, []);
    assert.equal(again.outcomes[0].status, 'interrupted');
    await assertFixturesIntact(root, files);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an issue whose lease is still live is held, not recovered or run', async () => {
  const root = await tmp();
  try {
    const clock = { t: 1000 };
    const store = await createStateStore({ workRoot: root, now: () => clock.t });
    await store.acquireLease('7', 'other');
    await store.beginPhase('7', 'testing');
    clock.t += 1000;
    const calls = [];
    const result = await runQueue({ workRoot: root, queue: ['7'], now: () => clock.t, handler: async () => { calls.push(1); return {}; } });
    assert.deepEqual(calls, []);
    assert.deepEqual([result.outcomes[0].status, result.outcomes[0].owner], ['held', 'other']);
    assert.equal((await store.load('7')).lease.owner, 'other');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('reviewer unavailable: no developer retry consumed, artifacts kept, issue retried on the next wake', async () => {
  const root = await tmp();
  try {
    const files = await writeFixtures(root, '8');
    let reviewerUp = false;
    const failures = [{ exitCode: 1, output: 'boom' }, { timedOut: true }, { exitCode: 0, output: '   ' }];
    const handler = async ({ phase }) => {
      if (phase === 'developing') return { exitCode: 0, output: 'ok', artifacts: files, changedFiles: 1 };
      if (phase === 'reviewing' && !reviewerUp) return failures.shift() ?? { exitCode: 1 };
      return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' };
    };
    const opts = { workRoot: root, queue: ['8'], handler, maxDeveloperAttempts: 1, maxReviewerUnavailable: 10, maxWakesPerIssue: 10 };
    const store = await createStateStore({ workRoot: root });
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = await runQueue(opts);
      assert.equal(r.outcomes[0].status, 'waiting_external');
      assert.equal(r.outcomes[0].class, 'reviewer_unavailable');
      assert.equal(r.outcomes[0].decision, 'wait');
      seen.push(r.outcomes[0].reason);
      const s = await store.load('8');
      assert.equal(s.attempts.developer, 0, 'developer retry budget untouched');
      assert.equal(s.attempts.reviewerUnavailable, i + 1);
      assert.equal(s.checkpoint.phase, 'testing', 'work checkpoint kept; only the review is retried');
      await assertFixturesIntact(root, files);
    }
    assert.deepEqual(seen, ['nonzero_exit', 'timeout', 'empty_output']);
    reviewerUp = true;
    const final = await runQueue(opts);
    assert.equal(final.outcomes[0].status, 'done');
    assert.equal((await store.load('8')).attempts.developer, 0);
    await assertFixturesIntact(root, files);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('developer failures and valid rejections do consume the developer budget, then stop with artifacts kept', async () => {
  const root = await tmp();
  try {
    const files = await writeFixtures(root, '9');
    const handler = async ({ phase }) => phase === 'developing'
      ? { exitCode: 0, output: 'ok', artifacts: files }
      : phase === 'testing' ? { exitCode: 0 } : { exitCode: 0, output: '审查结论：打回\nfix it' };
    const r = await runQueue({ workRoot: root, queue: ['9'], handler, maxDeveloperAttempts: 2 });
    assert.equal(r.outcomes[0].status, 'stop');
    assert.equal(r.outcomes[0].reason, 'developer_budget_exhausted');
    assert.equal(r.outcomes[0].decision, 'stop');
    const s = await (await createStateStore({ workRoot: root })).load('9');
    assert.equal(s.attempts.developer, 2);
    assert.equal(s.attempts.reviewerUnavailable, 0);
    await assertFixturesIntact(root, files);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('wake budget is durable across runs and ends in stop without calling the handler', async () => {
  const root = await tmp();
  try {
    let calls = 0;
    const handler = async ({ phase }) => { calls++; return phase === 'reviewing' ? { exitCode: 1 } : { exitCode: 0, output: 'ok' }; };
    const opts = { workRoot: root, queue: ['3'], handler, maxWakesPerIssue: 2, maxReviewerUnavailable: 99 };
    assert.equal((await runQueue(opts)).outcomes[0].status, 'waiting_external');
    assert.equal((await runQueue(opts)).outcomes[0].status, 'waiting_external');
    const before = calls;
    const third = await runQueue(opts);
    assert.equal(calls, before);
    assert.equal(third.outcomes[0].status, 'stop');
    assert.equal(third.outcomes[0].reason, 'wake_budget_exhausted');
    assert.equal((await (await createStateStore({ workRoot: root })).load('3')).attempts.wakes, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('human block and scope mismatch end the wake with ask; path escapes in artifacts count as scope mismatch', async () => {
  const root = await tmp();
  try {
    const r1 = await runQueue({ workRoot: root, queue: ['1'], handler: async () => ({ exitCode: 0, output: 'ok', humanBlock: true }) });
    assert.deepEqual([r1.outcomes[0].status, r1.outcomes[0].class, r1.outcomes[0].decision], ['waiting_person', 'human_block', 'ask']);
    const r2 = await runQueue({ workRoot: root, queue: ['2'], handler: async () => ({ exitCode: 0, output: 'ok', scopeMismatch: true }) });
    assert.deepEqual([r2.outcomes[0].status, r2.outcomes[0].class], ['out-of-scope', 'scope_mismatch']);
    const r3 = await runQueue({ workRoot: root, queue: ['3'], handler: async () => ({ exitCode: 0, output: 'ok', artifacts: { diff: '../../etc/passwd' } }) });
    assert.deepEqual([r3.outcomes[0].status, r3.outcomes[0].class], ['out-of-scope', 'scope_mismatch']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const useHeartbeat of [true, false]) {
  test(`lock lost mid-wake (${useHeartbeat ? 'detected by heartbeat' : 'detected after the handler returns'}): the wake aborts, the thief's lock and issue state survive`, async () => {
    const root = await tmp();
    try {
      const files = await writeFixtures(root, '9');
      const clock = { t: 1_000_000 };
      const lockPath = join(root, 'rtd.lock');
      const phases = [];
      let thief;
      const handler = async ({ item, phase, heartbeat, recordArtifacts }) => {
        phases.push(`${item.id}:${phase}`);
        await recordArtifacts(files);
        // Our lock lease runs out and another process takes the lock over.
        clock.t += 10 * 60_000;
        thief = await acquireLock({ lockPath, owner: 'thief', now: () => clock.t });
        assert.equal(thief.acquired, true);
        if (useHeartbeat) await heartbeat();
        return { exitCode: 0, output: 'ok', changedFiles: 1 };
      };
      const result = await runQueue({ workRoot: root, queue: ['9', '10'], handler, now: () => clock.t, lockTtlMs: 60_000 });
      assert.equal(result.status, 'lock_lost');
      assert.deepEqual(phases, ['9:developing'], 'no further handler runs, neither for this issue nor for the next one');
      assert.equal(result.outcomes.length, 1);
      assert.deepEqual([result.outcomes[0].id, result.outcomes[0].status, result.outcomes[0].decision], ['9', 'lock_lost', 'wait']);

      assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, thief.token, 'the other process\'s lock is untouched');
      const store = await createStateStore({ workRoot: root, now: () => clock.t });
      const state = await store.load('9');
      assert.equal(state.checkpoint, null, 'the interrupted phase is not checkpointed');
      assert.equal(state.lease, null, 'our own issue lease is released');
      assert.equal(state.artifacts.worktree, files.worktree);
      await assertFixturesIntact(root, files);
      assert.equal((await store.load('10')).attempts.wakes, 0, 'the next issue was never woken');
      await thief.release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
