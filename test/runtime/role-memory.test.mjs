import test from 'node:test';
import assert from 'node:assert/strict';
import { reflect } from '../../runtime/lib/reflect.mjs';
import { LIMITS, preload, fetchEntry, promote, rollback, prune } from '../../runtime/lib/role-memory.mjs';

const memoryStore = () => {
  const rows = new Map();
  return {
    rows,
    save: (entry) => rows.set(entry.id, { ...entry }),
    get: (id) => rows.get(id),
    update: (id, patch) => Object.assign(rows.get(id), patch),
    remove: (id) => rows.delete(id),
    list: () => [...rows.values()],
  };
};
const fakeProvider = (reply) => ({ async call() { return reply; } });
const memoryLog = () => ({ entries: [], append(entry) { this.entries.push(entry); } });
const lesson = (cue) => ({ cue, lesson: `handle ${cue}`, evidence: 'event evidence', confidence: 0.9, class: 'code' });

test('a lesson recorded in task A is preloaded for role session of task B', async () => {
  const store = memoryStore();
  const event = { id: 'A1', at: 1, type: 'stall' };
  await reflect({ event, provider: fakeProvider(lesson('gate lint fails on import order')), store, role: 'developer' });
  const text = preload({ store, role: 'developer' });
  assert.match(text, /L2 A1: gate lint fails on import order/);
  assert.equal(preload({ store, role: 'reviewer' }), '');
});

test('preload stays under the char cap even with a large synthetic memory', async () => {
  const store = memoryStore();
  for (let i = 0; i < 200; i += 1) store.save({ layer: 2, role: 'developer', id: `e${i}`, ...lesson(`cue number ${i} `.repeat(5)) });
  const text = preload({ store, role: 'developer', cap: 500 });
  assert.ok(text.length > 0);
  assert.ok(text.length <= 500);
});

test('layer sizes stay under caps; repeated lessons are promoted; rule can be rolled back', async () => {
  const store = memoryStore();
  for (let i = 0; i < 3; i += 1) {
    await reflect({ event: { id: `r${i}`, at: i }, provider: fakeProvider(lesson('Stale lock file')), store, role: 'fixer' });
  }
  assert.deepEqual(promote({ store, role: 'fixer' }), ['rule:fixer:stale lock file']);
  assert.deepEqual(promote({ store, role: 'fixer' }), []);
  assert.match(preload({ store, role: 'fixer' }), /L3 rule:fixer:stale lock file: handle Stale lock file/);

  assert.deepEqual(rollback({ store, id: 'rule:fixer:stale lock file' }), { status: 'rolled_back' });
  assert.doesNotMatch(preload({ store, role: 'fixer' }), /L3 /);
  assert.deepEqual(promote({ store, role: 'fixer' }), []);

  for (let i = 0; i < LIMITS.layer2 + 10; i += 1) store.save({ layer: 2, role: 'fixer', id: `x${i}`, ...lesson(`other ${i}`) });
  prune({ store, role: 'fixer' });
  const layer2 = store.list().filter((r) => r.layer === 2 && r.role === 'fixer');
  assert.equal(layer2.length, LIMITS.layer2);
  assert.equal(layer2.at(-1).id, `x${LIMITS.layer2 + 9}`);
});

test('each on-demand fetch of a layer-2 or layer-1 record appends one log entry', () => {
  const store = memoryStore();
  const log = memoryLog();
  store.save({ layer: 2, role: 'developer', id: 'e1', ...lesson('cue') });
  store.save({ layer: 1, role: 'developer', id: 't1', task: 'A' });
  assert.equal(fetchEntry({ store, log, layer: 2, id: 'e1' }).cue, 'cue');
  assert.equal(log.entries.length, 1);
  fetchEntry({ store, log, layer: 1, id: 't1' });
  fetchEntry({ store, log, layer: 2, id: 'e1' });
  assert.deepEqual(log.entries, [{ layer: 2, id: 'e1' }, { layer: 1, id: 't1' }, { layer: 2, id: 'e1' }]);
});
