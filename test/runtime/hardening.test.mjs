// Regression tests for the threat model of issue #49 (sections 2-6: rtd, state, classify, queue, paths).
// Test names start with the area, as listed in the threat table; the threat id is in the comment above each test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import fsp, { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runQueue } from '../../runtime/rtd.mjs';
import { createStateStore, StaleEpochError } from '../../runtime/lib/state.mjs';
import { classify } from '../../runtime/lib/classify.mjs';
import { readQueue } from '../../runtime/lib/queue.mjs';
import { createConfinement } from '../../runtime/lib/paths.mjs';

const RTD = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));

const tmp = () => mkdtemp(join(tmpdir(), 'rt-hard-'));
const PASS = '审查结论：通过\nok';
const okHandler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' });
const stateFile = (root, id) => {
  const dir = join(root, 'state');
  let names = [];
  try { names = readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const prefix = `~${Buffer.from(id).toString('hex')}.epoch-`;
  const epochs = names.filter((n) => n.startsWith(prefix) && /^\d+\.json$/.test(n.slice(prefix.length))).map((n) => Number(n.slice(prefix.length, -5)));
  return join(dir, epochs.length ? `${prefix}${Math.max(...epochs)}.json` : `${id}.json`);
};
const seedState = async (root, id, text) => { await mkdir(join(root, 'state'), { recursive: true }); await writeFile(stateFile(root, id), typeof text === 'string' ? text : JSON.stringify(text)); };
const withRoot = (fn) => async () => { const root = await tmp(); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };

// ---- R1: a handler result that is not a real success never reaches done ----
for (const [name, bad] of [['undefined', () => undefined], ['null', () => null], ['exitCode null with a signal', () => ({ exitCode: null, signal: 'SIGKILL', output: 'x' })], ['no exitCode', () => ({ output: 'x' })]]) {
  test(`recovery: handler returning ${name} in testing and finalizing never reaches done`, withRoot(async (root) => {
    const testing = await runQueue({ workRoot: root, queue: ['t'], maxDeveloperAttempts: 1, handler: async (a) => (a.phase === 'testing' ? bad() : okHandler(a)) });
    assert.notEqual(testing.outcomes[0].status, 'done');
    assert.equal(testing.outcomes[0].class, 'test_failure');
    const finalizing = await runQueue({ workRoot: root, queue: ['f'], handler: async (a) => (a.phase === 'finalizing' ? bad() : okHandler(a)) });
    const o = finalizing.outcomes[0];
    assert.equal(o.status, 'interrupted');
    assert.equal(o.class, 'finalize_failure');
    assert.equal(o.decision, 'ask');
    assert.equal((await createStateStore({ workRoot: root }).then((s) => s.load('f'))).recovery.resumePhase, 'finalizing');
  }));
}

// ---- R4: state writes are fenced by lock epoch ----
test('recovery: state writes are fenced by lock epoch', withRoot(async (root) => {
  const handler = async ({ phase }) => {
    if (phase === 'developing') { // a successor with a higher epoch writes the issue's state while we are paused
      const thief = await createStateStore({ workRoot: root });
      thief.setEpoch(1000);
      await thief.update('1', (s) => { s.changedFiles = 7; });
    }
    return okHandler({ phase });
  };
  const result = await runQueue({ workRoot: root, queue: ['1', '2'], handler });
  assert.equal(result.status, 'lock_lost');
  assert.deepEqual(result.outcomes.map((o) => [o.id, o.status]), [['1', 'lock_lost']]);
  const after = JSON.parse(await readFile(stateFile(root, '1'), 'utf8'));
  assert.equal(after.lockEpoch, 1000);
  assert.equal(after.changedFiles, 7);
  assert.equal(after.checkpoint, null, 'our checkpoint was refused');
  assert.equal(after.lease?.owner.startsWith('rtd-'), true, 'our lease release was refused too');
}));

test('recovery: a lower-epoch store is refused, an equal or higher one is accepted, state unchanged on refusal', withRoot(async (root) => {
  const a = await createStateStore({ workRoot: root });
  const b = await createStateStore({ workRoot: root });
  a.setEpoch(1); b.setEpoch(2);
  await a.update('1', (s) => { s.changedFiles = 1; });
  await b.update('1', (s) => { s.changedFiles = 2; });
  const bytes = await readFile(stateFile(root, '1'), 'utf8');
  await assert.rejects(a.update('1', (s) => { s.changedFiles = 3; }), StaleEpochError);
  await assert.rejects(a.checkpoint('1', 'developing'), StaleEpochError);
  assert.equal(await readFile(stateFile(root, '1'), 'utf8'), bytes);
  await b.update('1', (s) => { s.changedFiles = 4; });
  assert.equal((await b.load('1')).lockEpoch, 2);
}));

// ---- R5: corrupt state for one issue does not abort the pass ----
for (const [name, text] of [['garbage', '{not json\u0000'], ['empty file', ''], ['an array', '[]']]) {
  test(`recovery: corrupt state (${name}) for issue A does not prevent issue B`, withRoot(async (root) => {
    await seedState(root, 'A', text);
    const result = await runQueue({ workRoot: root, queue: ['A', 'B'], handler: okHandler });
    assert.equal(result.status, 'ok');
    const [a, b] = result.outcomes;
    assert.deepEqual([a.id, a.status, a.reason], ['A', 'failed', 'corrupt_state']);
    assert.equal(a.decision, 'ask');
    assert.deepEqual([b.id, b.status], ['B', 'done']);
    assert.equal(await readFile(stateFile(root, 'A'), 'utf8'), text, 'the corrupt file is preserved byte for byte');
    assert.deepEqual((await readdir(join(root, 'state'))).sort(), ['A.json', '~42.epoch-1.json']);
  }));
}

// ---- R2: phase and queue timeouts ----
test('renewal: phaseTimeoutMs aborts a never-settling handler', withRoot(async (root) => {
  let aborted = false;
  const hang = (stage) => async (a) => {
    if (a.stage !== stage) return okHandler(a);
    a.signal.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  };
  // Each hung handler is abandoned (never settles), so its lock stays held until the TTL: one work root per run.
  const reviewer = await runQueue({ workRoot: join(root, 'w1'), queue: ['r'], handler: hang('reviewer'), phaseTimeoutMs: 80, graceMs: 20 });
  assert.equal(aborted, true, 'the handler signal was aborted');
  assert.deepEqual([reviewer.outcomes[0].status, reviewer.outcomes[0].class, reviewer.outcomes[0].reason], ['waiting_external', 'reviewer_unavailable', 'timeout']);
  aborted = false;
  const developer = await runQueue({ workRoot: join(root, 'w2'), queue: ['d'], handler: hang('developer'), phaseTimeoutMs: 80, graceMs: 20, maxDeveloperAttempts: 1 });
  assert.deepEqual([developer.outcomes[0].status, developer.outcomes[0].class], ['stop', 'developer_failure']);
  const finalizer = await runQueue({ workRoot: join(root, 'w3'), queue: ['f'], handler: hang('finalize'), phaseTimeoutMs: 80, graceMs: 20 });
  assert.deepEqual([finalizer.outcomes[0].status, finalizer.outcomes[0].class, finalizer.outcomes[0].reason], ['interrupted', 'finalize_failure', 'timeout']);
  assert.deepEqual([reviewer.abandonedHandler, developer.abandonedHandler, finalizer.abandonedHandler], [true, true, true]);
  // A handler that settles on abort (inside the grace period) releases the lock: the next pass acquires it right away.
  const settling = async (a) => (a.stage === 'reviewer' ? new Promise((_, reject) => a.signal.addEventListener('abort', () => reject(new Error('aborted')))) : okHandler(a));
  const settled = await runQueue({ workRoot: root, queue: ['s'], handler: settling, phaseTimeoutMs: 80, graceMs: 500 });
  assert.equal(settled.abandonedHandler, undefined);
  const next = await runQueue({ workRoot: root, queue: ['n'], handler: okHandler });
  assert.equal(next.status, 'ok');
}));

test('renewal: queueTimeoutMs aborts a never-settling queue provider', withRoot(async (root) => {
  let signal;
  await assert.rejects(runQueue({ workRoot: root, queue: (opts) => { signal = opts.signal; return new Promise(() => {}); }, handler: okHandler, queueTimeoutMs: 80 }), { code: 'RT_QUEUE_TIMEOUT' });
  assert.equal(signal.aborted, true);
  const next = await runQueue({ workRoot: root, queue: ['n'], handler: okHandler });
  assert.equal(next.status, 'ok', 'the lock was released');
  await assert.rejects(runQueue({ workRoot: root, queue: [], handler: okHandler, phaseTimeoutMs: 0 }), TypeError);
}));

// ---- R3: a blocked loop that outlives the lease is detected ----
test('renewal: lease expiry during a blocked loop is detected as lock_lost', withRoot(async (root) => {
  const clock = { t: Date.now() };
  const handler = async (a) => { clock.t += 10 * 60_000; return okHandler(a); }; // "synchronous work" longer than lockTtlMs
  const result = await runQueue({ workRoot: root, queue: ['1'], handler, now: () => clock.t, lockTtlMs: 60_000 });
  assert.equal(result.status, 'lock_lost');
  const s = await (await createStateStore({ workRoot: root })).load('1');
  assert.equal(s.checkpoint, null, 'nothing was checkpointed');
}));

// ---- R6: owners are unique per run ----
test('recovery: owner ids are unique per process start', withRoot(async (root) => {
  const owners = [];
  const handler = async (a) => { owners.push(a.state.lease.owner); return okHandler(a); };
  await runQueue({ workRoot: root, queue: ['1'], handler });
  await runQueue({ workRoot: root, queue: ['2'], handler });
  assert.equal(new Set(owners).size, 2);
  assert.ok(owners.every((o) => o.startsWith(`rtd-${process.pid}-`)));
  // A lease of a crashed run with the same pid is not mistaken for ours.
  await seedState(root, '3', { status: 'queued', lease: { owner: `rtd-${process.pid}`, expiresAt: Date.now() + 60_000 } });
  const r = await runQueue({ workRoot: root, queue: ['3'], handler: okHandler });
  assert.deepEqual([r.outcomes[0].status, r.outcomes[0].owner], ['held', `rtd-${process.pid}`]);
}));

// ---- R7: the lock is per work root ----
test('lock: runtime lock is stored under .roundtable/state and ignored by git', withRoot(async (root) => {
  const result = await runQueue({ workRoot: root, queue: [], handler: okHandler });
  assert.equal(result.status, 'ok');
  const lockDir = join(root, '.roundtable', 'state', 'rtd.lock.d');
  assert.ok((await readdir(lockDir)).some((name) => /^epoch-\d+$/.test(name)));
  await assert.rejects(readdir(join(root, 'rtd.lock.d')), { code: 'ENOENT' });

  const ignored = spawnSync('git', ['check-ignore', '--no-index', '.roundtable/state/rtd.lock.d/epoch-1'], { encoding: 'utf8' });
  assert.equal(ignored.status, 0, ignored.stderr || ignored.stdout);
  assert.match(ignored.stdout, /^\.roundtable(?:\/state\/rtd\.lock\.d\/)?/m);
}));

test('lock: two runQueue on the same work root with different queue files -> second is locked', withRoot(async (root) => {
  await writeFile(join(root, 'q1.json'), JSON.stringify(['1']));
  await writeFile(join(root, 'q2.json'), JSON.stringify(['2']));
  let second;
  const handler = async (a) => { second ??= await runQueue({ workRoot: root, queue: 'q2.json', handler: okHandler }); return okHandler(a); };
  const first = await runQueue({ workRoot: root, queue: 'q1.json', handler });
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'locked');
}));

// ---- S1 ----
test('state: malformed attempts/artifacts are rejected or normalised, budgets still enforced', withRoot(async (root) => {
  await seedState(root, 'e', { id: 'e', status: 'queued', attempts: {} });
  const store = await createStateStore({ workRoot: root });
  assert.deepEqual((await store.load('e')).attempts, { developer: 0, reviewerUnavailable: 0, wakes: 0 });
  let calls = 0;
  const handler = async (a) => { calls++; return a.phase === 'reviewing' ? { exitCode: 1 } : okHandler(a); }; // reviewer unavailable: not terminal
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await runQueue({ workRoot: root, queue: ['e'], handler, maxWakesPerIssue: 2, maxReviewerUnavailable: 99 })).outcomes[0].status);
  assert.deepEqual(statuses.slice(0, 3), ['waiting_external', 'waiting_external', 'stop']);
  assert.equal(statuses[3], 'stop');
  assert.ok(calls <= 6);
  for (const [name, body] of [['"x" counter', { attempts: { wakes: 'x' } }], ['negative', { attempts: { developer: -1 } }], ['NaN-ish', { attempts: { wakes: 1.5 } }], ['attempts null', { attempts: null }], ['artifacts null', { artifacts: null }], ['history string', { artifactHistory: 'x' }]]) {
    await seedState(root, 'bad', { status: 'queued', ...body });
    await assert.rejects(store.load('bad'), { code: 'RT_CORRUPT_STATE' }, name);
  }
  await seedState(root, 'bad', { status: 'queued', attempts: { wakes: 'x' } });
  const r = await runQueue({ workRoot: root, queue: ['bad'], handler: okHandler });
  assert.deepEqual([r.outcomes[0].status, r.outcomes[0].reason], ['failed', 'corrupt_state']);
}));

// ---- S2 ----
test('state: update(a) never writes another issue\'s file', withRoot(async (root) => {
  await seedState(root, 'a', { id: 'b', status: 'queued' });
  await seedState(root, 'b', 'SENTINEL');
  const store = await createStateStore({ workRoot: root });
  assert.equal((await store.load('a')).id, 'a');
  await store.update('a', (s) => { s.changedFiles = 1; });
  assert.equal(await readFile(stateFile(root, 'b'), 'utf8'), 'SENTINEL');
  assert.equal(JSON.parse(await readFile(stateFile(root, 'a'), 'utf8')).id, 'a');
}));

// ---- S3 / S4 ----
function spyFs(log, { names = [] } = {}) {
  let n = 0;
  return {
    ...fsPromises(),
    async open(path, flags, mode) {
      const fh = await fsp.open(path, flags, mode);
      const isDir = flags === 'r';
      return {
        writeFile: async (d) => { log.push('write'); return fh.writeFile(d); },
        sync: async () => { log.push(isDir ? 'fsync-dir' : 'fsync-file'); return fh.sync(); },
        close: () => fh.close(),
      };
    },
    async rename(a, b) { log.push('rename'); return fsp.rename(a, b); },
    next: () => names[n++] ?? `u${n}`,
  };
}
function fsPromises() { return { mkdir: fsp.mkdir, unlink: fsp.unlink, readFile: fsp.readFile }; }

test('state: save fsyncs temp file and directory before resolving', withRoot(async (root) => {
  const log = [];
  const store = await createStateStore({ workRoot: root, fs: spyFs(log) });
  await store.update('1', (s) => { s.changedFiles = 1; });
  assert.deepEqual(log, ['write', 'fsync-file', 'rename', 'fsync-dir']);
}));

test('state: save temp uses exclusive create', withRoot(async (root) => {
  const sentinel = join(root, 'outside.txt');
  await writeFile(sentinel, 'SENTINEL');
  await mkdir(join(root, 'state'));
  const spy = spyFs([], { names: ['fixed', 'fresh'] });
  await symlink(sentinel, join(root, 'state', `1.json.${process.pid}.fixed.tmp`));
  const store = await createStateStore({ workRoot: root, fs: spy, randomId: spy.next });
  await store.update('1', (s) => { s.changedFiles = 1; });
  assert.equal(await readFile(sentinel, 'utf8'), 'SENTINEL');
  assert.equal((await store.load('1')).changedFiles, 1);
}));

// ---- S5 / S6 ----
test('state: artifact records are append-only across attempts', withRoot(async (root) => {
  const store = await createStateStore({ workRoot: root });
  await store.recordArtifacts('1', { diff: 'out/a.diff', output: 'out/a.txt' });
  await store.retryDeveloper('1', 'developer_failure', 'x');
  await store.recordArtifacts('1', { diff: 'out/b.diff' });
  const s = await store.load('1');
  assert.equal(s.artifacts.diff, join(root, 'out/b.diff'));
  assert.deepEqual(s.artifactHistory.map((h) => [h.key, h.path, h.attempt]), [
    ['diff', join(root, 'out/a.diff'), 0], ['output', join(root, 'out/a.txt'), 0], ['diff', join(root, 'out/b.diff'), 1]]);
  await store.recordArtifacts('1', { diff: 'out/b.diff' }); // same path again: no duplicate entry
  assert.equal((await store.load('1')).artifactHistory.length, 3);
  const bytes = await readFile(stateFile(root, '1'), 'utf8');
  await assert.rejects(store.recordArtifacts('1', { diff: 'out/c.diff', patch: 'out/p' }), TypeError);
  assert.equal(await readFile(stateFile(root, '1'), 'utf8'), bytes, 'an unknown key is rejected, nothing is recorded');
}));

test('state: recorded artifact path is the confined absolute path', withRoot(async (root) => {
  const store = await createStateStore({ workRoot: root });
  await store.recordArtifacts('1', { worktree: 'wt/x' });
  assert.equal((await store.load('1')).artifacts.worktree, resolve(root, 'wt/x'));
}));

// ---- S7 / S8 ----
test('state: recover recomputes staleness inside update', withRoot(async (root) => {
  const clock = { t: 1_000_000 };
  const store = await createStateStore({ workRoot: root, now: () => clock.t, leaseTtlMs: 1000, heartbeatTimeoutMs: 5000 });
  await store.acquireLease('1', 'a');
  await store.beginPhase('1', 'developing');
  clock.t += 60_000; // lease and heartbeat are stale for any snapshot read now
  const [, rec] = await Promise.all([store.heartbeat('1', 'a'), store.recover('1')]);
  assert.equal(rec.action, 'held');
  assert.equal((await store.load('1')).lastEvent.type, 'phase_started', 'no recovered event');
}));

test('state: heartbeat with no lease is a no-op', withRoot(async (root) => {
  const store = await createStateStore({ workRoot: root });
  await store.heartbeat('1', 'a');
  await assert.rejects(readFile(stateFile(root, '1')), { code: 'ENOENT' });
  await store.beginPhase('1', 'developing');
  const bytes = await readFile(stateFile(root, '1'), 'utf8');
  await store.heartbeat('1', 'a');
  assert.equal(await readFile(stateFile(root, '1'), 'utf8'), bytes);
}));

// ---- classify ----
test('classify: exitCode null/undefined, or signal set -> failure class for every stage', () => {
  const expected = { developer: 'developer_failure', test: 'test_failure', reviewer: 'reviewer_unavailable', finalize: 'finalize_failure' };
  for (const [stage, cls] of Object.entries(expected)) {
    for (const e of [{}, { exitCode: null }, { exitCode: undefined, output: PASS }, { exitCode: '0', output: PASS }, { exitCode: NaN, output: PASS }, { exitCode: 0, signal: 'SIGKILL', output: PASS }, { exitCode: null, signal: 'SIGTERM', output: PASS }]) {
      assert.equal(classify({ stage, output: 'x', ...e }).class, cls, `${stage} ${JSON.stringify(e)}`);
    }
    assert.ok(['ok', 'review_passed'].includes(classify({ stage, exitCode: 0, output: PASS }).class), `${stage} exit 0 is success`);
  }
});

test('classify: any truthy timedOut is a timeout in every stage', () => {
  for (const stage of ['developer', 'test', 'reviewer', 'finalize']) {
    for (const timedOut of [true, 'yes', 1]) {
      const r = classify({ stage, exitCode: 0, output: PASS, timedOut });
      assert.equal(r.reason, 'timeout', `${stage} ${String(timedOut)}`);
      assert.ok(!['ok', 'review_passed'].includes(r.class));
    }
  }
});

test('classify: verdict must be the only token on the first line; 通过/打回/阻塞 map to passed/rejected/human_block', () => {
  const review = (output) => classify({ stage: 'reviewer', exitCode: 0, output });
  for (const bad of ['审查结论：通过 但是…', '审查结论：通过。', 'ok\n审查结论：通过', '审查结论：通过 打回', '审查结论：']) {
    assert.equal(review(bad).class, 'reviewer_unavailable', bad);
  }
  assert.equal(review('审查结论：通过').class, 'review_passed');
  assert.equal(review('审查结论：打回\nwhy').class, 'review_rejected');
  assert.equal(review('审查结论：阻塞').class, 'human_block');
});

test('classify: reviewer_unavailable.consumesDeveloperRetry === false', () => {
  for (const e of [{ exitCode: 1 }, { timedOut: true }, { exitCode: null, signal: 'SIGKILL' }, { exitCode: 0, output: 'nope' }]) {
    const r = classify({ stage: 'reviewer', ...e });
    assert.equal(r.class, 'reviewer_unavailable');
    assert.equal(r.consumesDeveloperRetry, false);
    assert.equal(r.preserveArtifacts, true);
  }
});

test('classify: 5 unavailable reviews leave developer attempts and artifacts unchanged', withRoot(async (root) => {
  await mkdir(join(root, 'out'));
  await writeFile(join(root, 'out/1.txt'), 'model output');
  const handler = async ({ phase }) => (phase === 'reviewing' ? { exitCode: null, signal: 'SIGKILL' } : { exitCode: 0, output: 'ok', artifacts: { output: 'out/1.txt' } });
  for (let i = 0; i < 4; i++) await runQueue({ workRoot: root, queue: ['1'], handler, maxReviewerUnavailable: 99 });
  const s = await (await createStateStore({ workRoot: root })).load('1');
  assert.equal(s.attempts.developer, 0);
  assert.equal(s.attempts.reviewerUnavailable, 4);
  assert.deepEqual(s.artifacts, { output: join(root, 'out/1.txt') });
  assert.equal(await readFile(join(root, 'out/1.txt'), 'utf8'), 'model output');
}));

// ---- queue ----
test('queue: ids differing only by case are treated as duplicates (first wins)', async () => {
  const { items } = await readQueue(['Abc', 'abc', { id: 'ABC' }, 'other']);
  assert.deepEqual(items.map((i) => i.id), ['Abc', 'other']);
});

test('queue: a malformed entry is skipped with reason "invalid" and the rest are returned', async () => {
  const { items, skipped } = await readQueue(['a', {}, { id: 'b', priority: 'high' }, { id: ['x'] }, { id: 'c', state: 5 }, 'd']);
  assert.deepEqual(items.map((i) => i.id), ['a', 'd']);
  assert.deepEqual(skipped.map((s) => [s.index, s.reason]), [[1, 'invalid'], [2, 'invalid'], [3, 'invalid'], [4, 'invalid']]);
});

test('queue: file larger than limit -> TypeError, no parse', withRoot(async (root) => {
  const confinement = await createConfinement(root);
  await writeFile(join(root, 'q.json'), JSON.stringify(Array.from({ length: 200 }, (_, i) => `id${i}`)));
  await assert.rejects(readQueue('q.json', { confinement, maxBytes: 100 }), TypeError);
  assert.equal((await readQueue('q.json', { confinement })).items.length, 200);
  await writeFile(join(root, 'huge.json'), `${'['.repeat(2 * 1024 * 1024)}`); // would be a SyntaxError if it were parsed
  await assert.rejects(readQueue('huge.json', { confinement }), (e) => e instanceof TypeError && !(e instanceof SyntaxError));
}));

test('queue+recovery: queue says queued, durable says done -> skipped', withRoot(async (root) => {
  let calls = 0;
  const handler = async (a) => { calls++; return okHandler(a); };
  await runQueue({ workRoot: root, queue: ['1'], handler });
  const before = calls;
  const again = await runQueue({ workRoot: root, queue: [{ id: '1', state: 'queued' }], handler });
  assert.deepEqual([again.outcomes[0].status, again.outcomes[0].skipped], ['done', true]);
  assert.equal(calls, before);
}));

// ---- paths ----
test('paths: workRoot \'/\' is rejected up front', async () => {
  await assert.rejects(createConfinement('/'), TypeError);
  await assert.rejects(runQueue({ workRoot: '/', queue: [], handler: okHandler }), TypeError);
});

// ---- R2 follow-up: a timed-out phase is closed, never overlaps a retry, and the timers keep the process alive ----
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const hungPhase of ['developing', 'testing']) {
  test(`timeout: an abandoned ${hungPhase} handler cannot write after its phase closed, and no retry starts in the same wake`, withRoot(async (root) => {
    await writeFile(join(root, 'late.txt'), 'x');
    let invocations = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let late;
    const handler = async (a) => {
      if (a.phase !== hungPhase || invocations > 0) return okHandler(a);
      invocations++;
      // Ignores the abort signal; acts only after the wake ended (graceMs is much shorter than the gate).
      await gate;
      late = await Promise.allSettled([a.recordArtifacts({ output: 'late.txt' }), a.heartbeat()]);
      return { exitCode: 0, output: 'late' };
    };
    const first = await runQueue({ workRoot: root, queue: ['A'], handler, phaseTimeoutMs: 60, graceMs: 30, maxDeveloperAttempts: 3 });
    assert.equal(first.status, 'ok');
    assert.equal(first.abandonedHandler, true);
    assert.equal(invocations, 1, 'no second handler invocation started in the same wake');
    assert.deepEqual([first.outcomes[0].status, first.outcomes[0].class, first.outcomes[0].reason, first.outcomes[0].decision], ['queued', hungPhase === 'developing' ? 'developer_failure' : 'test_failure', 'timeout', 'wait']);
    const before = await readFile(stateFile(root, 'A'), 'utf8');
    const s = JSON.parse(before);
    assert.equal(s.status, 'queued');
    assert.equal(s.attempts.developer, 1, 'the retry budget still counts');
    assert.equal(s.checkpoint, null);
    assert.equal(s.lease?.owner.startsWith('rtd-'), true, 'the lease of an abandoned handler is kept until its TTL');
    assert.deepEqual([s.recovery.interruptedPhase, s.recovery.resumePhase], [hungPhase, 'developing']);
    assert.deepEqual([s.lastEvent.type, s.lastEvent.detail], [hungPhase === 'developing' ? 'developer_failure' : 'test_failure', 'timeout']);

    release();
    for (let i = 0; i < 100 && !late; i++) await sleep(10);
    assert.ok(late, 'the abandoned handler did run its late calls');
    for (const r of late) {
      assert.equal(r.status, 'rejected');
      assert.match(r.reason.message, /phase closed/);
    }
    // Handler completion precedes asynchronous lease and lock release. Wait for both, with a real-time bound.
    const deadline = Date.now() + 5000;
    let after;
    let lockReleased = false;
    do {
      after = JSON.parse(await readFile(stateFile(root, 'A'), 'utf8'));
      const lockDir = join(root, '.roundtable', 'state', 'rtd.lock.d');
      const epoch = (await readdir(lockDir)).filter((n) => /^epoch-\d+$/.test(n)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))).at(-1);
      lockReleased = JSON.parse(await readFile(join(lockDir, epoch), 'utf8')).released === true;
      if (after.lease === null && lockReleased) break;
      await sleep(10);
    } while (Date.now() < deadline);
    const expected = JSON.parse(before);
    assert.equal(after.lease, null, 'the settled handler releases its lease');
    assert.equal(lockReleased, true, 'the settled handler releases its lock');
    expected.lease = null;
    assert.deepEqual(after, expected, 'late recordArtifacts / heartbeat wrote nothing');

    const second = await runQueue({ workRoot: root, queue: ['A'], handler });
    assert.equal(second.outcomes[0].status, 'done', 'the next wake after cleanup resumes and finishes');
    assert.equal(second.abandonedHandler, undefined);
  }));
}

test('timeout: the wake waits up to graceMs for the abandoned handler; its calls inside the grace period are refused too', withRoot(async (root) => {
  await writeFile(join(root, 'late.txt'), 'x');
  let late;
  let settledAt = 0;
  const handler = async (a) => {
    if (a.phase !== 'developing') return okHandler(a);
    await sleep(150); // phaseTimeoutMs is 50, graceMs 2000: this settles inside the grace period
    late = await Promise.allSettled([a.recordArtifacts({ output: 'late.txt' }), a.heartbeat()]);
    settledAt = Date.now();
    return { exitCode: 0, output: 'late' };
  };
  const r = await runQueue({ workRoot: root, queue: ['A'], handler, phaseTimeoutMs: 50, graceMs: 2000 });
  assert.ok(settledAt > 0, 'the handler settled before the wake ended');
  assert.ok(late.every((x) => x.status === 'rejected' && /phase closed/.test(x.reason.message)));
  assert.equal(r.outcomes[0].status, 'queued');
  assert.deepEqual(JSON.parse(await readFile(stateFile(root, 'A'), 'utf8')).artifacts, {}, 'nothing was recorded');
}));

test('timeout: a timed-out developer phase spends the retry budget and stops at the limit; reviewer and finalizing end the wake too', withRoot(async (root) => {
  const hang = (stage) => async (a) => (a.stage === stage ? new Promise(() => {}) : okHandler(a));
  // A never-settling handler keeps lock and lease until the TTL: the clock is skewed past it between passes.
  let skew = 0;
  const now = () => Date.now() + skew;
  const opts = { phaseTimeoutMs: 40, graceMs: 10, now };
  const d = await runQueue({ workRoot: root, queue: ['d'], handler: hang('developer'), maxDeveloperAttempts: 2, maxWakesPerIssue: 9, ...opts });
  assert.equal(d.outcomes[0].status, 'queued');
  skew += 10 * 60_000;
  const d2 = await runQueue({ workRoot: root, queue: ['d'], handler: hang('developer'), maxDeveloperAttempts: 2, maxWakesPerIssue: 9, ...opts });
  assert.deepEqual([d2.outcomes[0].status, d2.outcomes[0].reason], ['stop', 'developer_budget_exhausted']);
  skew += 10 * 60_000;
  const r = await runQueue({ workRoot: root, queue: ['r'], handler: hang('reviewer'), ...opts });
  assert.deepEqual([r.outcomes[0].status, r.outcomes[0].reason], ['waiting_external', 'timeout']);
  skew += 10 * 60_000;
  const f = await runQueue({ workRoot: root, queue: ['f'], handler: hang('finalize'), ...opts });
  assert.deepEqual([f.outcomes[0].status, f.outcomes[0].reason], ['interrupted', 'timeout']);
  await assert.rejects(runQueue({ workRoot: root, queue: [], handler: okHandler, graceMs: -1 }), TypeError);
}));

const runChild = (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const killer = setTimeout(() => child.kill('SIGKILL'), 20000); // a hung child fails the test instead of the run
  child.on('close', (code, signal) => { clearTimeout(killer); resolve({ code, signal, out, err }); });
});

for (const phase of ['developing', 'finalizing']) {
  test(`timeout: the CLI exits on its own after a never-settling ${phase} handler, with the timeout recorded in state`, { timeout: 30000 }, withRoot(async (root) => {
    await writeFile(join(root, 'queue.json'), JSON.stringify([{ id: '1' }]));
    await writeFile(join(root, 'handler.mjs'), `export default ({ phase }) => (phase === ${JSON.stringify(phase)} ? new Promise(() => {}) : Promise.resolve({ exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过\\nok' : 'ok' }));\n`);
    const r = await runChild([RTD, '--work-root', root, '--queue', 'queue.json', '--handler', join(root, 'handler.mjs'), '--phase-timeout-ms', '200', '--grace-ms', '50']);
    assert.equal(r.signal, null, 'the process ended by itself');
    assert.notEqual(r.out.trim(), '', 'not a silent exit');
    const result = JSON.parse(r.out);
    assert.equal(r.code, 0, 'a recorded timeout is a normal pass result: ok maps to 0');
    assert.equal(result.status, 'ok');
    assert.equal(result.outcomes[0].reason, 'timeout');
    const s = JSON.parse(await readFile(stateFile(root, '1'), 'utf8'));
    assert.equal(result.abandonedHandler, true);
    assert.equal(s.lease?.owner.startsWith('rtd-'), true, 'the lease of an abandoned handler is kept until its TTL');
    if (phase === 'developing') {
      assert.deepEqual([s.status, s.attempts.developer, s.lastEvent.type, s.lastEvent.detail], ['queued', 1, 'developer_failure', 'timeout']);
    } else {
      assert.deepEqual([s.status, s.recovery.resumePhase, s.lastEvent.type, s.lastEvent.detail], ['interrupted', 'finalizing', 'finalize_failure', 'finalizing']);
    }
  }));
}

// ---- single-flight: an abandoned handler (never settles after its timeout and grace) keeps lock and lease until their TTL ----
test('timeout: an abandoned handler keeps the queue lock and issue lease until it settles', withRoot(async (root) => {
  let started = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handler = async (a) => {
    if (a.phase !== 'developing') return okHandler(a);
    started++;
    if (started === 1) return gate; // ignores the abort signal
    return okHandler(a);
  };
  let skew = 0;
  const now = () => Date.now() + skew;
  const opts = { workRoot: root, queue: ['A'], handler, now, phaseTimeoutMs: 60, graceMs: 30, lockTtlMs: 1000, lockRenewMinMs: 100, leaseTtlMs: 60_000 };
  const first = await runQueue(opts);
  assert.equal(first.status, 'ok');
  assert.equal(first.abandonedHandler, true);
  assert.deepEqual([first.outcomes[0].status, first.outcomes[0].reason], ['queued', 'timeout']);
  assert.equal(started, 1);
  const recorded = await readFile(stateFile(root, 'A'), 'utf8');
  assert.equal(JSON.parse(recorded).lease?.owner.startsWith('rtd-'), true, 'the lease was not released');
  const lockDir = join(root, '.roundtable', 'state', 'rtd.lock.d');
  assert.equal(JSON.parse(await readFile(join(lockDir, (await readdir(lockDir)).filter((n) => /^epoch-/.test(n)).sort().pop()), 'utf8')).released, undefined, 'the lock was not released');

  // Before the lock TTL ends: busy, no handler, state untouched.
  const second = await runQueue(opts);
  assert.equal(second.status, 'locked');
  assert.equal(started, 1, 'no second handler started');
  assert.equal(await readFile(stateFile(root, 'A'), 'utf8'), recorded, 'the recorded status was not overwritten');

  // After the handler settles, ownership can be released and a successor can resume.
  release();
  await sleep(100);
  skew = 5000;
  const third = await runQueue(opts);
  assert.equal(third.status, 'ok');
  assert.equal(third.outcomes[0].status, 'done');
  assert.equal(started, 2);
}));

test('timeout: a handler that settles within graceMs releases the queue lock and the issue lease', withRoot(async (root) => {
  const handler = async (a) => {
    if (a.phase !== 'developing') return okHandler(a);
    await sleep(120); // ignores the signal, but settles inside the grace period
    return { exitCode: 0, output: 'late' };
  };
  const r = await runQueue({ workRoot: root, queue: ['A'], handler, phaseTimeoutMs: 50, graceMs: 2000 });
  assert.equal(r.abandonedHandler, undefined);
  assert.equal(r.outcomes[0].status, 'queued');
  assert.equal(JSON.parse(await readFile(stateFile(root, 'A'), 'utf8')).lease, null);
  const next = await runQueue({ workRoot: root, queue: ['A'], handler: okHandler });
  assert.equal(next.status, 'ok', 'the lock was released');
  assert.equal(next.outcomes[0].status, 'done');
}));

test('timeout: the CLI exits by itself after an abandoned handler (flag set), and the unexpired lease still fences a second CLI run', { timeout: 40000 }, withRoot(async (root) => {
  await writeFile(join(root, 'queue.json'), JSON.stringify([{ id: '1' }]));
  await writeFile(join(root, 'handler.mjs'), `import { appendFile } from 'node:fs/promises';
await appendFile(${JSON.stringify(join(root, 'starts.txt'))}, 'import\\n');
export default async ({ phase }) => {
  await appendFile(${JSON.stringify(join(root, 'starts.txt'))}, phase + '\\n');
  if (phase === 'developing') {
    setInterval(() => {}, 1000); // a live handle that would keep the process alive forever without process.exit
    return new Promise(() => {}); // ignores abort, never settles
  }
  return { exitCode: 0, output: 'ok' };
};
`);
  const args = [RTD, '--work-root', root, '--queue', 'queue.json', '--handler', join(root, 'handler.mjs'), '--phase-timeout-ms', '200', '--grace-ms', '50'];
  const startedAt = Date.now();
  const r = await runChild(args);
  const elapsed = Date.now() - startedAt;
  assert.equal(r.signal, null, 'the process ended by itself, it was not killed');
  assert.ok(elapsed < 200 + 50 + 5000, `exited within timeout + grace + margin (took ${elapsed} ms)`);
  const result = JSON.parse(r.out);
  assert.equal(r.code, 0, 'exit code mapping is unchanged: ok maps to 0');
  assert.equal(result.status, 'ok');
  assert.equal(result.abandonedHandler, true);
  assert.equal(result.outcomes[0].reason, 'timeout');
  assert.equal(JSON.parse(await readFile(stateFile(root, '1'), 'utf8')).lease?.owner.startsWith('rtd-'), true);
  // The process (and with it the handler) is gone, so a same-host successor may take the lock over; the issue lease
  // is still unexpired and fences the issue: no handler starts.
  const before = await readFile(join(root, 'starts.txt'), 'utf8');
  const stateBefore = await readFile(stateFile(root, '1'), 'utf8');
  const again = await runChild(args);
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out).outcomes[0].status, 'held');
  assert.equal(await readFile(join(root, 'starts.txt'), 'utf8'), `${before}import\n`, 'only the module import ran, no handler started');
  assert.equal(await readFile(stateFile(root, '1'), 'utf8'), stateBefore, 'the recorded status was not overwritten');
}));

test('timeout: the CLI rejects malformed timeout flags with exit 2', { timeout: 30000 }, withRoot(async (root) => {
  for (const flag of [['--phase-timeout-ms', '0'], ['--phase-timeout-ms', 'abc'], ['--grace-ms', '-5'], ['--queue-timeout-ms', '1.5']]) {
    const r = await runChild([RTD, '--work-root', root, '--queue', 'q.json', '--handler', 'h.mjs', ...flag]);
    assert.equal(r.code, 2, flag.join(' '));
  }
}));

test('timeout: a never-settling queue provider ends the process with RT_QUEUE_TIMEOUT instead of a silent exit', { timeout: 30000 }, withRoot(async (root) => {
  const script = join(root, 'provider.mjs');
  await writeFile(script, `import { runQueue } from ${JSON.stringify(new URL('../../runtime/rtd.mjs', import.meta.url).href)};
runQueue({ workRoot: process.env.RT_TEST_ROOT, queue: () => new Promise(() => {}), handler: async () => ({ exitCode: 0, output: 'ok' }), queueTimeoutMs: 200 })
  .then(() => { console.log('{"settled":"ok"}'); }, (e) => { console.log(JSON.stringify({ code: e.code })); process.exitCode = 3; });
`);
  const r = await runChild([script], { RT_TEST_ROOT: root });
  assert.equal(r.signal, null);
  assert.deepEqual([r.code, JSON.parse(r.out || '{}').code], [3, 'RT_QUEUE_TIMEOUT']);
}));

test('state: a paused old epoch cannot replace a successor checkpoint or artifacts', withRoot(async (root) => {
  let resume, reached;
  const paused = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  const old = await createStateStore({ workRoot: root, fs: { ...fsp, async rename(a, b) { reached(); await gate; return fsp.rename(a, b); } } });
  old.setEpoch(1);
  const pending = old.update('race', (s) => { s.checkpoint = { phase: 'developing', at: 1 }; s.artifacts.output = 'old'; });
  await paused;
  const moduleUrl = new URL('../../runtime/lib/state.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { createStateStore } from ${JSON.stringify(moduleUrl)}; const s = await createStateStore({workRoot: process.argv[1]}); s.setEpoch(2); await s.update('race', x => { x.checkpoint = {phase:'testing', at:2}; x.artifacts.output = 'new'; });`, root], { stdio: 'inherit' });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  resume();
  await pending;
  const state = await old.load('race');
  assert.equal(state.checkpoint.phase, 'testing');
  assert.equal(state.artifacts.output, 'new');
}));

test('timeout: renewal prevents a second runner after the original TTL while the handler runs', withRoot(async (root) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const opts = { workRoot: root, queue: ['A'], handler: async () => { await gate; return { exitCode: 0 }; }, phaseTimeoutMs: 30, graceMs: 10, lockTtlMs: 180, lockRenewMinMs: 30, leaseTtlMs: 180 };
  const first = await runQueue(opts);
  assert.equal(first.abandonedHandler, true);
  await sleep(450);
  const runnerUrl = new URL('../../runtime/rtd.mjs', import.meta.url).href;
  const script = `import { runQueue } from ${JSON.stringify(runnerUrl)}; import { writeFile } from 'node:fs/promises'; const r = await runQueue({workRoot:process.argv[1], queue:['A'], handler:async () => ({exitCode:0}), lockTtlMs:180, lockRenewMinMs:30, leaseTtlMs:180}); await writeFile(process.argv[2], r.status);`;
  const resultFile = join(root, 'contender-result');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, resultFile], { stdio: 'inherit' });
  try {
    assert.equal(await new Promise((resolve) => child.on('exit', resolve)), 0);
    assert.equal(await readFile(resultFile, 'utf8'), 'locked');
    const state = await createStateStore({ workRoot: root }).then((store) => store.load('A'));
    assert.ok(state.lease.expiresAt > Date.now(), 'the issue lease is also renewed');
  } finally { release(); }
}));
