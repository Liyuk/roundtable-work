import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { PathEscapeError } from '../../runtime/lib/paths.mjs';

async function setup(opts = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rt-state-'));
  const clock = { t: 1_000_000 };
  const store = await createStateStore({ workRoot: root, now: () => clock.t, leaseTtlMs: 1000, heartbeatTimeoutMs: 5000, ...opts });
  return { root, clock, store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('fresh state has zeroed counters; updates persist across store instances', async () => {
  const { root, store, cleanup } = await setup();
  try {
    assert.deepEqual((await store.load('49')).attempts, { developer: 0, reviewerUnavailable: 0, wakes: 0 });
    await store.beginPhase('49', 'developing');
    await store.checkpoint('49', 'developing', { changedFiles: 3 });
    const again = await (await createStateStore({ workRoot: root })).load('49');
    assert.equal(again.checkpoint.phase, 'developing');
    assert.equal(again.changedFiles, 3);
    assert.equal(again.lastEvent.type, 'checkpoint');
  } finally { await cleanup(); }
});

test('writes are atomic: valid JSON on disk and no temp files left behind', async () => {
  const { root, store, cleanup } = await setup();
  try {
    await Promise.all([1, 2, 3, 4, 5].map((i) => store.update(`i${i}`, (s) => { s.changedFiles = i; })));
    const names = await readdir(join(root, 'state'));
    assert.equal(names.length, 5);
    assert.ok(names.every((n) => n.endsWith('.json')));
    for (const n of names) JSON.parse(await readFile(join(root, 'state', n), 'utf8'));
  } finally { await cleanup(); }
});

test('developer attempts and reviewer-unavailable counts are tracked separately', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.bump('1', 'developer');
    await store.bump('1', 'reviewerUnavailable');
    await store.bump('1', 'reviewerUnavailable');
    const s = await store.load('1');
    assert.equal(s.attempts.developer, 1);
    assert.equal(s.attempts.reviewerUnavailable, 2);
    await assert.rejects(store.bump('1', 'bogus'), TypeError);
  } finally { await cleanup(); }
});

test('lease: exclusive while unexpired, takeable after expiry, released only by its owner', async () => {
  const { clock, store, cleanup } = await setup();
  try {
    assert.equal((await store.acquireLease('1', 'a')).acquired, true);
    assert.equal((await store.acquireLease('1', 'b')).acquired, false);
    await store.releaseLease('1', 'b');
    assert.equal((await store.load('1')).lease.owner, 'a');
    clock.t += 1001;
    assert.equal((await store.acquireLease('1', 'b')).acquired, true);
    await store.releaseLease('1', 'b');
    assert.equal((await store.load('1')).lease, null);
  } finally { await cleanup(); }
});

test('stale lease and stale heartbeat are detected with the injected clock', async () => {
  const { clock, store, cleanup } = await setup();
  try {
    await store.acquireLease('1', 'a');
    assert.deepEqual(store.staleness(await store.load('1')), { leaseExpired: false, heartbeatStale: false, stale: false });
    clock.t += 1500; // lease (1s) expired, heartbeat (5s) still fresh
    assert.deepEqual(store.staleness(await store.load('1')), { leaseExpired: true, heartbeatStale: false, stale: true });
    await store.heartbeat('1', 'a'); // the owner's heartbeat renews its lease
    assert.equal(store.staleness(await store.load('1')).stale, false);
    clock.t += 900;
    assert.equal(store.staleness(await store.load('1')).stale, false);
    clock.t += 6000;
    assert.equal(store.staleness(await store.load('1')).heartbeatStale, true);
  } finally { await cleanup(); }
});

test('heartbeat by a non-owner does not extend the lease', async () => {
  const { clock, store, cleanup } = await setup();
  try {
    await store.acquireLease('1', 'a');
    clock.t += 900;
    await store.heartbeat('1', 'intruder');
    clock.t += 200;
    assert.equal(store.staleness(await store.load('1')).leaseExpired, true);
  } finally { await cleanup(); }
});

test('artifact paths are recorded, and paths outside the work root are rejected without being recorded', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.recordArtifacts('1', { worktree: 'wt/1', diff: 'out/1.diff', output: 'out/1.txt' });
    assert.deepEqual((await store.load('1')).artifacts, { worktree: 'wt/1', diff: 'out/1.diff', output: 'out/1.txt' });
    await assert.rejects(store.recordArtifacts('1', { diff: '../elsewhere.diff' }), PathEscapeError);
    assert.equal((await store.load('1')).artifacts.diff, 'out/1.diff');
  } finally { await cleanup(); }
});

test('issue ids that could escape the state directory are rejected', async () => {
  const { store, cleanup } = await setup();
  try {
    await assert.rejects(store.load('../evil'), PathEscapeError);
    await assert.rejects(store.update('a/b', () => {}), PathEscapeError);
  } finally { await cleanup(); }
});

test('unknown phases are rejected', async () => {
  const { store, cleanup } = await setup();
  try {
    await assert.rejects(store.beginPhase('1', 'dancing'), TypeError);
    await assert.rejects(store.checkpoint('1', 'dancing'), TypeError);
  } finally { await cleanup(); }
});
