import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReflection, reflect, resolveReflection } from '../../runtime/lib/reflect.mjs';

const memoryStore = () => {
  const rows = new Map();
  return {
    rows,
    save: (entry) => rows.set(entry.id, { ...entry }),
    get: (id) => rows.get(id),
    update: (id, patch) => Object.assign(rows.get(id), patch),
    remove: (id) => rows.delete(id),
  };
};
const fakeProvider = (reply) => ({ calls: 0, async call() { this.calls += 1; return reply; } });
const ENTRY = { cue: 'gate lint fails on import order', lesson: 'run lint --fix before verify', evidence: 'event 12 gate fail', confidence: 0.8, class: 'code' };
const event = { id: 'e1', at: 100, type: 'stall' };

test('parseReflection accepts NO_ENTRY and validated entries, rejects malformed ones', () => {
  assert.equal(parseReflection('NO_ENTRY'), 'NO_ENTRY');
  assert.equal(parseReflection({ ...ENTRY, evidence: '  ' }), 'NO_ENTRY');
  assert.deepEqual(parseReflection(ENTRY), ENTRY);
  assert.throws(() => parseReflection({ ...ENTRY, confidence: 2 }), TypeError);
  assert.throws(() => parseReflection({ ...ENTRY, cue: '' }), TypeError);
  assert.throws(() => parseReflection('maybe'), TypeError);
});

test('thin evidence gives NO_ENTRY: one provider call, no store write', async () => {
  const store = memoryStore();
  const provider = fakeProvider('NO_ENTRY');
  assert.deepEqual(await reflect({ event, provider, store }), { status: 'NO_ENTRY' });
  assert.equal(provider.calls, 1);
  assert.equal(store.rows.size, 0);
});

test('an entry is saved to layer 2 without confirmation; a cited entry not repeated is kept', async () => {
  const store = memoryStore();
  const result = await reflect({ event, provider: fakeProvider(ENTRY), store, role: 'fixer' });
  assert.equal(result.status, 'saved');
  assert.deepEqual(store.get('e1'), { layer: 2, role: 'fixer', id: 'e1', ...ENTRY });
  assert.deepEqual(resolveReflection({ store, id: 'e1', cited: true, laterClass: 'infra' }), { status: 'kept' });
  assert.equal(store.get('e1').status, 'kept');
});

test('a cited entry contradicted by the same failure class is demoted; an uncited one is untouched', async () => {
  const store = memoryStore();
  await reflect({ event, provider: fakeProvider({ ...ENTRY, class: undefined }), store });
  assert.equal(store.get('e1').class, 'unknown');
  assert.deepEqual(resolveReflection({ store, id: 'e1', cited: false, laterClass: 'unknown' }), { status: 'unkept' });
  assert.ok(store.get('e1'));
  assert.deepEqual(resolveReflection({ store, id: 'e1', cited: true, laterClass: 'unknown' }), { status: 'demoted' });
  assert.equal(store.get('e1'), undefined);
});
