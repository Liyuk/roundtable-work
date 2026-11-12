import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
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
  const { root, store, cleanup } = await setup();
  try {
    await store.recordArtifacts('1', { worktree: 'wt/1', diff: 'out/1.diff', output: 'out/1.txt' });
    // Stored as the confined absolute path (threat S6).
    assert.deepEqual((await store.load('1')).artifacts, { worktree: join(root, 'wt/1'), diff: join(root, 'out/1.diff'), output: join(root, 'out/1.txt') });
    await assert.rejects(store.recordArtifacts('1', { diff: '../elsewhere.diff' }), PathEscapeError);
    assert.equal((await store.load('1')).artifacts.diff, join(root, 'out/1.diff'));
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

test('concurrent heartbeat and recordArtifacts never lose an artifact (updates for one id are serialised)', async () => {
  const { root, store, cleanup } = await setup();
  try {
    for (let round = 0; round < 60; round++) {
      const id = `c${round}`;
      await store.acquireLease(id, 'a');
      // A second store on the same work root shares the queue: serialisation is per state file, not per store object.
      const other = await createStateStore({ workRoot: root, now: () => 1_000_000, leaseTtlMs: 1000 });
      await Promise.all([
        store.heartbeat(id, 'a'), other.heartbeat(id, 'a'),
        store.recordArtifacts(id, { worktree: `wt/${round}` }),
        other.heartbeat(id, 'a'),
        other.recordArtifacts(id, { diff: `out/${round}.diff` }),
        store.heartbeat(id, 'a'),
        store.recordArtifacts(id, { output: `out/${round}.txt` }),
        store.heartbeat(id, 'a'),
      ]);
      assert.deepEqual((await store.load(id)).artifacts, { worktree: join(root, `wt/${round}`), diff: join(root, `out/${round}.diff`), output: join(root, `out/${round}.txt`) }, `round ${round}`);
    }
  } finally { await cleanup(); }
});

test('a failing update does not wedge later updates for the same id, and nothing is written for it', async () => {
  const { store, cleanup } = await setup();
  try {
    await store.update('1', (s) => { s.changedFiles = 1; });
    const results = await Promise.allSettled([
      store.update('1', (s) => { s.changedFiles = 2; }),
      store.update('1', () => { throw new Error('boom'); }),
      store.recordArtifacts('1', { diff: '../escape.diff' }),
      store.update('1', (s) => { s.changedFiles += 10; }),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'rejected', 'fulfilled']);
    assert.equal((await store.load('1')).changedFiles, 12);
  } finally { await cleanup(); }
});

test('an update that changes nothing, or a lease release by a non-owner, writes nothing', async () => {
  const { root, store, cleanup } = await setup();
  try {
    await store.acquireLease('1', 'a');
    const file = join(root, 'state', '1.json');
    const snap = async () => ({ raw: await readFile(file, 'utf8'), ino: (await stat(file)).ino });
    const before = await snap();
    await store.releaseLease('1', 'intruder');
    await store.update('1', () => {});
    await store.heartbeat('1', 'intruder');
    assert.deepEqual(await snap(), before);
    await store.releaseLease('1', 'a');
    assert.equal((await store.load('1')).lease, null);
    assert.notEqual((await snap()).ino, before.ino, 'the owner\'s release is written');
  } finally { await cleanup(); }
});

test('state save cannot follow an ancestor swapped during the write', async () => {
  const fs = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'rt-state-race-'));
  const outside = await mkdtemp(join(tmpdir(), 'rt-state-outside-'));
  try {
    await fs.mkdir(join(root, 'state'));
    let swapped = false;
    const store = await createStateStore({ workRoot: root, fs: { ...fs, async mkdir(...args) {
      let result;
      let error;
      try { result = await fs.mkdir(...args); } catch (err) { error = err; }
      if (!swapped) {
        swapped = true;
        await fs.rename(join(root, 'state'), join(root, 'moved'));
        await fs.symlink(outside, join(root, 'state'));
      }
      if (error) throw error;
      return result;
    } } });
    await store.save({ id: '1' }).catch(() => {});
    assert.equal(swapped, true);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
