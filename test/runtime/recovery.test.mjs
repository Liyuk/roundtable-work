import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runQueue, exitCodeFor, EXIT_LOCKED, EXIT_LOCK_LOST } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { acquireLock, hostId, lockDirectoryFor } from '../../runtime/lib/lock.mjs';

const RTD = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
const tmp = () => mkdtemp(join(tmpdir(), 'rt-recovery-'));
const exists = (p) => access(p).then(() => true, () => false);
const PASS = '审查结论：通过\nok';
// Runtime lock records live in the private anchor (RTW_STATE_DIR, inherited by every child process), never in
// the work root: `.roundtable/state/rtd.lock.d` is only the caller-side path whose last component names the lock.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-recovery-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* leaving /tmp behind is harmless */ } });
const lockPathOf = (root) => join(root, '.roundtable', 'state', 'rtd.lock.d');
const lockDirOf = (root) => lockDirectoryFor({ lockPath: lockPathOf(root), repoRoot: root, anchorRoot: ANCHOR });
const epochsIn = (root) => readdirSync(lockDirOf(root)).map((n) => /^epoch-(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
const plantEpoch = (root, rec) => writeFileSync(join(lockDirOf(root), `epoch-${Math.max(0, ...epochsIn(root)) + 1}`), JSON.stringify(rec));
const topHolder = (root) => JSON.parse(readFileSync(join(lockDirOf(root), `epoch-${Math.max(...epochsIn(root))}`), 'utf8'));

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
// Recorded artifact paths are the confined absolute paths (threat S6).
const absFiles = (root, files) => Object.fromEntries(Object.entries(files).map(([k, v]) => [k, join(root, v)]));
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
const sha = 'a'.repeat(40);
// The trusted handler module exports the read-only observation clients used by the real CLI path.
export const observationClients = {
  expectedSha: () => sha,
  issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
  worktree: { async inspect() { return { dirty: false }; } },
  git: { async head() { return sha; }, async commit() { return { sha }; } },
  evidence: { async checks() { return { sha, conclusion: 'success' }; }, async review() { return { sha, conclusion: 'approved' }; } },
};
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
    const child = spawn(process.execPath, [RTD, '--work-root', root, '--queue', 'queue.json', '--routing', fileURLToPath(new URL('./routing-fixture.json', import.meta.url)), '--handler', join(root, 'handler.mjs')],
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
    assert.equal(topHolder(root).released, true, 'lock is released on exit');
  } finally { await cleanup(); }
});

test('single-flight: a locked run reports the holder, runs nothing and leaves the holder\'s lock in place', { timeout: 20000 }, async () => {
  const root = await tmp();
  try {
    const holder = await acquireLock({ lockPath: lockPathOf(root), repoRoot: root, owner: 'other' });
    assert.equal(holder.acquired, true);
    let calls = 0;
    const result = await runQueue({ workRoot: root, queue: ['1'], handler: async () => { calls++; return {}; } });
    assert.equal(result.status, 'locked');
    assert.equal(result.holder.owner, 'other');
    assert.equal(calls, 0);
    assert.equal(topHolder(root).released, undefined, 'a run that never got the lock must not release it');
    assert.equal(topHolder(root).token, holder.token);
    await holder.release();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('single-flight: a lock whose process died is stale and is taken over', { timeout: 20000 }, async () => {
  const root = await tmp();
  try {
    const dead = spawnSync(process.execPath, ['-e', '']);
    assert.equal(dead.status, 0);
    mkdirSync(lockDirOf(root), { recursive: true, mode: 0o700 });
    plantEpoch(root, { owner: 'old', pid: dead.pid, hostId: hostId(), token: 'x', epoch: 1, acquiredAt: Date.now(), expiresAt: Date.now() + 3_600_000 });
    const result = await runQueue({ workRoot: root, queue: ['1'], handler: async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' }) });
    assert.equal(result.status, 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('single-flight: a live holder with an expired lock lease is stale; with a fresh lease it is not', async () => {
  const root = await tmp();
  try {
    const clock = { t: 10_000 };
    const lockPath = lockPathOf(root);
    const a = await acquireLock({ lockPath, repoRoot: root, owner: 'a', now: () => clock.t, ttlMs: 1000 });
    assert.equal(a.acquired, true);
    assert.equal((await acquireLock({ lockPath, repoRoot: root, owner: 'b', now: () => clock.t, ttlMs: 1000 })).acquired, false);
    clock.t += 1001;
    const b = await acquireLock({ lockPath, repoRoot: root, owner: 'b', now: () => clock.t, ttlMs: 1000 });
    assert.equal(b.acquired, true);
    assert.equal(await a.refresh(), false, 'the displaced owner can no longer refresh');
    assert.equal(await a.release(), true); // only rewrites a's own, superseded epoch file
    assert.equal(topHolder(root).token, b.token, "b's lock is untouched");
    assert.equal(topHolder(root).released, undefined);
    assert.equal(await b.release(), true);
    assert.equal(topHolder(root).released, true);
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
    assert.equal(mid.artifacts.output, join(root, 'out/49.txt'));
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
    assert.equal(end.recovery.artifacts.output, join(root, 'out/49.txt'));
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
    assert.deepEqual(rec.state.artifacts, absFiles(root, files));
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
      const lockPath = lockPathOf(root);
      const phases = [];
      let thief;
      const handler = async ({ item, phase, heartbeat, recordArtifacts }) => {
        phases.push(`${item.id}:${phase}`);
        await recordArtifacts(files);
        // Our lock lease runs out and another process takes the lock over.
        clock.t += 10 * 60_000;
        thief = await acquireLock({ lockPath, repoRoot: root, owner: 'thief', now: () => clock.t });
        assert.equal(thief.acquired, true);
        if (useHeartbeat) await heartbeat();
        return { exitCode: 0, output: 'ok', changedFiles: 1 };
      };
      const result = await runQueue({ workRoot: root, queue: ['9', '10'], handler, now: () => clock.t, lockTtlMs: 60_000 });
      assert.equal(result.status, 'lock_lost');
      assert.deepEqual(phases, ['9:developing'], 'no further handler runs, neither for this issue nor for the next one');
      assert.equal(result.outcomes.length, 1);
      assert.deepEqual([result.outcomes[0].id, result.outcomes[0].status, result.outcomes[0].decision], ['9', 'lock_lost', 'wait']);

      assert.equal(topHolder(root).token, thief.token, 'the other process\'s lock is untouched');
      const store = await createStateStore({ workRoot: root, now: () => clock.t });
      const state = await store.load('9');
      assert.equal(state.checkpoint, null, 'the interrupted phase is not checkpointed');
      // Old behaviour (lease released after the loss) was dropped on purpose: after a lost lock nothing is written.
      assert.ok(state.lease?.owner.startsWith(`rtd-${process.pid}-`), 'the lease is left as it was and expires on its own');
      assert.equal(state.artifacts.worktree, join(root, files.worktree));
      await assertFixturesIntact(root, files);
      assert.equal((await store.load('10')).attempts.wakes, 0, 'the next issue was never woken');
      await thief.release();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('developer retry: counter and checkpoint reset are one durable write; a crash right after it resumes at developing', async () => {
  const root = await tmp();
  const realRename = fsp.rename;
  const snapshots = [];
  let crashed = false;
  try {
    const clock = { t: 1_000_000 };
    // Simulate a process crash: once the retry write has landed, no further write reaches the disk.
    fsp.rename = async (from, to) => {
      if (crashed) throw new Error('simulated crash');
      await realRename(from, to);
      if (String(to).endsWith('~3439.epoch-1.json')) {
        const s = JSON.parse(await readFile(to, 'utf8'));
        snapshots.push({ developer: s.attempts.developer, checkpoint: s.checkpoint?.phase ?? null });
        if (s.attempts.developer === 1) crashed = true;
      }
    };
    syncBuiltinESMExports();
    const handler = async ({ phase }) => phase === 'developing' ? { exitCode: 0, output: 'ok' }
      : phase === 'testing' ? { exitCode: 0 } : { exitCode: 0, output: '审查结论：打回\nfix it' };
    await assert.rejects(runQueue({ workRoot: root, queue: ['49'], handler, now: () => clock.t }), /simulated crash/);
    fsp.rename = realRename;
    syncBuiltinESMExports();

    for (const snap of snapshots) if (snap.developer === 1) assert.equal(snap.checkpoint, null, 'no durable state has the bumped counter with the old checkpoint');
    const store = await createStateStore({ workRoot: root, now: () => clock.t });
    const mid = await store.load('49');
    assert.equal(mid.attempts.developer, 1);
    assert.equal(mid.checkpoint, null);

    clock.t += 3_600_000;
    const phases = [];
    const result = await runQueue({
      workRoot: root, queue: ['49'], now: () => clock.t, maxDeveloperAttempts: 2,
      handler: async (ctx) => { phases.push(ctx.phase); return handler(ctx); },
    });
    assert.equal(phases[0], 'developing', 'recovery resumes at developing, not at a later phase');
    assert.equal(result.outcomes[0].reason, 'developer_budget_exhausted');
    assert.equal((await store.load('49')).attempts.developer, 2, 'exactly one more retry was spent');
  } finally {
    fsp.rename = realRename;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

for (const failedPhase of ['developing', 'reviewing']) {
  test(`exhausted developer budget survives a crash after ${failedPhase} failure is recorded`, async () => {
    const root = await tmp();
    const realRename = fsp.rename;
    let crashed = false;
    try {
      const clock = { t: 1_000_000 };
      fsp.rename = async (from, to) => {
        if (crashed) throw new Error('simulated crash');
        await realRename(from, to);
        if (String(to).endsWith('~3636.epoch-1.json')) {
          const state = JSON.parse(await readFile(to, 'utf8'));
          if (state.attempts.developer === 1) crashed = true;
        }
      };
      syncBuiltinESMExports();
      const handler = async ({ phase }) => phase === failedPhase
        ? failedPhase === 'reviewing' ? { exitCode: 0, output: '审查结论：打回\nfix it' } : { exitCode: 1 }
        : { exitCode: 0, output: 'ok' };
      await assert.rejects(runQueue({ workRoot: root, queue: ['66'], handler, now: () => clock.t, maxDeveloperAttempts: 1 }), /simulated crash/);
      fsp.rename = realRename;
      syncBuiltinESMExports();
      const store = await createStateStore({ workRoot: root, now: () => clock.t });
      assert.equal((await store.load('66')).attempts.developer, 1);
      clock.t += 3_600_000;
      let calls = 0;
      const result = await runQueue({ workRoot: root, queue: ['66'], now: () => clock.t, maxDeveloperAttempts: 1,
        handler: async () => { calls++; return { exitCode: 0, output: PASS }; } });
      assert.equal(calls, 0, 'no phase starts after the final failure');
      assert.deepEqual([result.outcomes[0].status, result.outcomes[0].reason, result.outcomes[0].decision], ['stop', 'developer_budget_exhausted', 'stop']);
      const state = await store.load('66');
      assert.equal(state.status, 'stop');
      assert.equal(state.attempts.developer, 1);
    } finally {
      fsp.rename = realRename;
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('exhausted developer budget does not block resuming later checkpointed phases', async () => {
  const root = await tmp();
  try {
    const store = await createStateStore({ workRoot: root });
    await store.update('66', (s) => { s.attempts.developer = 1; s.checkpoint = { phase: 'testing', at: 1 }; });
    const phases = [];
    const result = await runQueue({ workRoot: root, queue: ['66'], maxDeveloperAttempts: 1,
      handler: async ({ phase }) => { phases.push(phase); return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' }; } });
    assert.deepEqual(phases, ['reviewing', 'finalizing']);
    assert.equal(result.outcomes[0].status, 'done');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a path escape thrown by the handler\'s own recordArtifacts() is a scope mismatch: no developer retry, artifacts kept', async () => {
  const root = await tmp();
  try {
    const outside = await mkdtemp(join(tmpdir(), 'rt-outside-'));
    try {
      await symlink(outside, join(root, 'dirlink'));
      const files = await writeFixtures(root, '12');
      const escapes = { dotdot: '../../etc/passwd', symlink: 'dirlink/secret' };
      for (const [name, bad] of Object.entries(escapes)) {
        const id = `esc-${name}`;
        let calls = 0;
        const handler = async ({ recordArtifacts }) => {
          calls++;
          await recordArtifacts({ output: files.output });
          await recordArtifacts({ diff: bad });
          return { exitCode: 0, output: 'ok' };
        };
        const r = await runQueue({ workRoot: root, queue: [id], handler, maxDeveloperAttempts: 5 });
        assert.deepEqual([r.outcomes[0].status, r.outcomes[0].class, r.outcomes[0].decision], ['out-of-scope', 'scope_mismatch', 'ask'], name);
        assert.equal(calls, 1, `${name}: handler not rerun`);
        const s = await (await createStateStore({ workRoot: root })).load(id);
        assert.equal(s.attempts.developer, 0, `${name}: no developer retry spent`);
        assert.equal(s.artifacts.output, join(root, files.output), `${name}: artifacts recorded before the escape are kept`);
        assert.equal(s.artifacts.diff, undefined);
      }
      await assertFixturesIntact(root, files);
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const [name, failure] of [['failure', { exitCode: 1, output: 'push failed' }], ['timeout', { timedOut: true }], ['handler error', null]]) {
  test(`finalizing ${name}: wake ends interrupted/ask, finalizing is not rerun, no developer retry spent, artifacts kept`, async () => {
    const root = await tmp();
    try {
      const files = await writeFixtures(root, '13');
      const phases = [];
      const handler = async ({ phase }) => {
        phases.push(phase);
        if (phase === 'developing') return { exitCode: 0, output: 'ok', artifacts: files, changedFiles: 1 };
        if (phase === 'finalizing') { if (failure === null) throw new Error('boom'); return failure; }
        return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' };
      };
      const opts = { workRoot: root, queue: ['13'], handler, maxDeveloperAttempts: 5 };
      const r = await runQueue(opts);
      assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing'], 'no rerun from development');
      assert.deepEqual([r.outcomes[0].status, r.outcomes[0].class, r.outcomes[0].decision, r.outcomes[0].phase], ['interrupted', 'finalize_failure', 'ask', 'finalizing']);
      const store = await createStateStore({ workRoot: root });
      const s = await store.load('13');
      assert.equal(s.status, 'interrupted');
      assert.equal(s.attempts.developer, 0);
      assert.equal(s.checkpoint.phase, 'reviewing', 'work checkpoint kept');
      assert.equal(s.recovery.resumePhase, 'finalizing');
      assert.equal(s.recovery.interruptedPhase, 'finalizing');
      assert.equal(s.recovery.lastCheckpoint, 'reviewing');
      assert.deepEqual(s.recovery.artifacts, absFiles(root, files));
      assert.equal(s.lease, null);
      await assertFixturesIntact(root, files);
      // A later pass does not pick it up on its own.
      const again = await runQueue(opts);
      assert.equal(again.outcomes[0].status, 'interrupted');
      assert.equal(phases.length, 4);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

// --- Lock renewal and lock loss while the queue is being read (injected provider) ---

// Generous margins: the lease is 600 ms, renewed every 200 ms (a third of it); a slow provider runs 2.5x the lease.
const QTTL = 600;
const QRENEW = { lockTtlMs: QTTL, lockRenewMinMs: 20 };
const qsleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stealLock = (root, token) => plantEpoch(root, { owner: 'successor', pid: process.pid, hostId: hostId(), token, acquiredAt: Date.now(), expiresAt: Date.now() + 60_000 });
async function snapshotState(root) {
  const dir = join(root, 'state');
  const names = await readdir(dir).catch((err) => { if (err.code === 'ENOENT') return []; throw err; });
  return Object.fromEntries(await Promise.all(names.sort().map(async (n) => [n, await readFile(join(dir, n), 'utf8')])));
}

test('a slow injected queue provider (longer than lockTtlMs) keeps the lock: a second runQueue gets locked', async () => {
  const root = await tmp();
  try {
    const probes = [];
    let secondRuns = 0;
    const provider = async () => {
      const end = Date.now() + Math.round(2.5 * QTTL);
      while (Date.now() < end) {
        await qsleep(150);
        const second = await runQueue({ workRoot: root, queue: ['1'], handler: async () => { secondRuns++; return { exitCode: 0 }; }, ...QRENEW });
        probes.push(second.status);
      }
      return ['1'];
    };
    const phases = [];
    const handler = async ({ phase }) => { phases.push(phase); return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' }; };
    const result = await runQueue({ workRoot: root, queue: provider, handler, ...QRENEW });
    assert.ok(probes.length >= 5, `probed ${probes.length} times`);
    assert.ok(probes.every((status) => status === 'locked'), JSON.stringify(probes));
    assert.equal(secondRuns, 0);
    assert.equal(result.status, 'ok');
    assert.equal(result.outcomes[0].status, 'done');
    assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing']);
    assert.equal((await runQueue({ workRoot: root, queue: ['2'], handler, ...QRENEW })).status, 'ok', 'the lock was released afterwards');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lock lost while the queue provider runs: lock_lost, no wake, handler never called, no state file created or changed', async () => {
  const root = await tmp();
  try {
    // Issue 8 already has state (written by an earlier pass); issue 9 has none.
    const seed = await createStateStore({ workRoot: root });
    await seed.update('8', (s) => { s.lease = { owner: 'rtd-successor', expiresAt: Date.now() + 60_000 }; s.checkpoint = { phase: 'testing', at: 1 }; });
    let before;
    let calls = 0;
    const provider = async () => {
      stealLock(root, 'succ-1'); // another process takes over the lock while the provider is still running
      before = await snapshotState(root);
      return [{ id: '8' }, { id: '9' }, { id: '10', state: 'done' }];
    };
    const handler = async () => { calls++; return { exitCode: 0, output: 'ok' }; };
    const result = await runQueue({ workRoot: root, queue: provider, handler, ...QRENEW });
    assert.equal(result.status, 'lock_lost');
    assert.deepEqual(result.outcomes, []);
    assert.deepEqual(result.skipped.map((x) => x.id), ['10']);
    assert.equal(exitCodeFor(result), EXIT_LOCK_LOST);
    assert.equal(calls, 0, 'the handler was never called');
    assert.deepEqual(Object.keys(before), ['8.json']);
    assert.deepEqual(await snapshotState(root), before, 'no state file was created or changed, byte for byte');
    assert.equal(topHolder(root).token, 'succ-1', 'the successor\'s lock is untouched');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('lock lost while an issue runs: its next state write is refused and the next wake never starts', async () => {
  // Adapted for the anchored fence (issue #77): a superseded writer is now refused at its *next state write*,
  // not only at the next wake's first refresh. The loss therefore ends issue 1 as `lock_lost` (its late
  // artifact write is rejected) instead of letting it finish and stopping before issue 2.
  const root = await tmp();
  try {
    const seen = [];
    const handler = async ({ item, phase }) => {
      seen.push(`${item.id}:${phase}`);
      if (item.id !== '1' || phase !== 'finalizing') return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' };
      // Issue 1's last refresh has already passed when `artifacts` is read, so the lock is lost before the
      // artifact write and before issue 2.
      return { exitCode: 0, output: 'ok', artifacts: { get output() { stealLock(root, 'succ-2'); return 'out/1.txt'; } } };
    };
    const result = await runQueue({ workRoot: root, queue: ['1', '2'], handler, ...QRENEW });
    assert.equal(result.status, 'lock_lost');
    assert.deepEqual(result.outcomes.map((o) => [o.id, o.status]), [['1', 'lock_lost']], 'the next wake never starts');
    assert.deepEqual(seen, ['1:developing', '1:testing', '1:reviewing', '1:finalizing'], 'no further phase or issue runs');
    assert.deepEqual(Object.keys(await snapshotState(root)), ['~31.epoch-1.json'], 'no state file was created for issue 2');
    assert.equal((await (await createStateStore({ workRoot: root })).load('1')).artifacts.output, undefined, 'the stale artifact write was refused');
  } finally { await rm(root, { recursive: true, force: true }); }
});
