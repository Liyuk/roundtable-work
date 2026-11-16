import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { openMemoryStore } from '../../runtime/lib/memory-store.mjs';
import { promote, rollback } from '../../runtime/lib/role-memory.mjs';
import { appendMemory, reflectOnce } from '../../runtime/rtd.mjs';
import { runQueue } from './observation-fixture.mjs';

const lesson = (cue) => ({ cue, lesson: `handle ${cue}`, evidence: 'event evidence', confidence: 0.9, class: 'code' });
const fakeProvider = (reply = () => lesson('gate lint fails')) => ({
  calls: [],
  async call(event) { this.calls.push(event); return reply(event); },
});
const layer2 = (store) => store.list().filter((r) => r.layer === 2);

async function withDir(run) {
  const root = await mkdtemp(join(process.cwd(), 'rt386-test-'));
  try { return await run(join(root, 'state')); } finally { await rm(root, { recursive: true, force: true }); }
}

test('file store keeps rows across reopen and appends fetch log entries', async () => {
  await withDir(async (dir) => {
    const store = openMemoryStore({ dir });
    store.save({ layer: 2, role: 'developer', id: 'a', cue: 'first', lesson: 'x' });
    store.save({ layer: 2, role: 'developer', id: 'b', cue: 'second', lesson: 'y' });
    store.update('a', { status: 'kept' });
    store.remove('b');
    store.save({ layer: 2, role: 'developer', id: 'c', cue: 'third', lesson: 'z' });
    store.log.append({ layer: 2, id: 'a' });

    const reopened = openMemoryStore({ dir });
    assert.deepEqual(reopened.list().map((r) => r.id), ['a', 'c']);
    assert.equal(reopened.get('a').status, 'kept');
    assert.deepEqual(reopened.get('c'), { layer: 2, role: 'developer', id: 'c', cue: 'third', lesson: 'z' });
    assert.equal(reopened.get('missing'), undefined);
  });
});

test('appendMemory adds nothing for an empty store and a capped ## Memory section otherwise', async () => {
  await withDir(async (dir) => {
    const store = openMemoryStore({ dir });
    assert.equal(appendMemory('PROMPT', { store, role: 'developer' }), 'PROMPT');
    for (let i = 0; i < 300; i += 1) store.save({ layer: 2, role: 'developer', id: `e${i}`, ...lesson(`cue number ${i} `.repeat(4)) });
    const out = appendMemory('PROMPT', { store, role: 'developer' });
    const [head, memory] = out.split('\n\n## Memory\n');
    assert.equal(head, 'PROMPT');
    assert.ok(memory.length > 0);
    assert.ok(memory.length <= 2000);
    assert.match(out, /^PROMPT\n\n## Memory\nL2 e0: /);
  });
});

test('a lesson saved by one run is preloaded for a role session of another run', async () => {
  await withDir(async (dir) => {
    const provider = fakeProvider();
    await reflectOnce({ store: openMemoryStore({ dir }), provider, role: 'developer', event: { id: 'run-a:done:1', at: 1, type: 'done' } });

    const later = openMemoryStore({ dir });
    assert.match(appendMemory('PROMPT', { store: later, role: 'developer' }), /L2 run-a:done:1: gate lint fails/);
    assert.equal(appendMemory('PROMPT', { store: later, role: 'reviewer' }), 'PROMPT');
  });
});

test('a rolled-back layer-3 rule is not preloaded after reopening the file store', async () => {
  await withDir(async (dir) => {
    const provider = fakeProvider();
    for (const n of [1, 2, 3]) await reflectOnce({ store: openMemoryStore({ dir }), provider, role: 'developer', event: { id: `e${n}`, at: n } });
    const store = openMemoryStore({ dir });
    assert.deepEqual(promote({ store, role: 'developer' }), ['rule:developer:gate lint fails']);
    assert.match(appendMemory('PROMPT', { store: openMemoryStore({ dir }), role: 'developer' }), /L3 rule:developer:gate lint fails/);

    rollback({ store, id: 'rule:developer:gate lint fails' });
    assert.doesNotMatch(appendMemory('PROMPT', { store: openMemoryStore({ dir }), role: 'developer' }), /L3 /);
  });
});

test('reflectOnce calls the provider once per event id and writes one layer-2 row', async () => {
  await withDir(async (dir) => {
    const store = openMemoryStore({ dir });
    const provider = fakeProvider();
    const event = { id: 'x:done:1', at: 1, type: 'done' };
    await reflectOnce({ store, provider, role: 'chief', event });
    await reflectOnce({ store: openMemoryStore({ dir }), provider, role: 'chief', event });
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(layer2(openMemoryStore({ dir })).map((r) => r.id), ['x:done:1']);
  });
});

const passing = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? 'Verdict: pass' : 'ok' });

test('runQueue reflects once on done, on a fix round and on a finalize failure', async () => {
  const cases = [
    { name: 'done', handler: passing, expect: ['7:done:1'] },
    { name: 'fix', handler: (() => { let failed = false; return async (args) => (args.phase === 'testing' && !failed && (failed = true) ? { exitCode: 1, output: 'tests failed' } : passing(args)); })(), expect: ['7:fix:1', '7:done:1'] },
    { name: 'gate_fail', handler: async (args) => (args.phase === 'finalizing' ? { exitCode: 1, output: 'finalize broke' } : passing(args)), expect: ['7:gate_fail:1'] },
  ];
  for (const { name, handler, expect } of cases) {
    await withDir(async (dir) => {
      const provider = fakeProvider(() => lesson(`cue ${name}`));
      const memory = { store: openMemoryStore({ dir }), provider };
      await runQueue({ workRoot: join(dir, '..'), queue: ['7'], handler, memory });
      assert.deepEqual(provider.calls.map((e) => e.id), expect, name);
      assert.equal(layer2(openMemoryStore({ dir })).length, expect.length, name);
    });
  }
});

test('a reflection provider error does not fail the wake', async () => {
  await withDir(async (dir) => {
    const failing = { store: openMemoryStore({ dir }), provider: { async call() { throw new Error('model down'); } } };
    const result = await runQueue({ workRoot: join(dir, '..'), queue: ['8'], handler: passing, memory: failing });
    assert.equal(result.outcomes[0].status, 'done');
    assert.equal(layer2(failing.store).length, 0);
  });
});
