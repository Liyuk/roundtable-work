import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQueue, TERMINAL_STATES } from '../../runtime/lib/queue.mjs';
import { createConfinement, PathEscapeError } from '../../runtime/lib/paths.mjs';
import { runQueue } from '../../runtime/rtd.mjs';

const tmp = () => mkdtemp(join(tmpdir(), 'rt-queue-'));
const okHandler = (calls = []) => async ({ item, phase }) => {
  calls.push(`${item.id}:${phase}`);
  return { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过\nlooks fine' : 'ok' };
};

test('readQueue orders by priority, then input order, and drops duplicate ids', async () => {
  const { items } = await readQueue([
    { id: '3' }, { id: '1', priority: 5 }, { id: '2' }, { id: '1', priority: 99 }, { id: '4', priority: 5 },
  ]);
  assert.deepEqual(items.map((i) => i.id), ['1', '4', '3', '2']);
});

test('readQueue skips every terminal state and reports them', async () => {
  const entries = TERMINAL_STATES.map((state, i) => ({ id: `t${i}`, state }));
  const { items, skipped } = await readQueue([...entries, { id: 'live', state: 'queued' }, 'bare']);
  assert.deepEqual(items.map((i) => i.id), ['live', 'bare']);
  assert.equal(skipped.length, TERMINAL_STATES.length);
  for (const s of ['done', 'stop', 'out-of-scope']) assert.ok(skipped.some((x) => x.state === s));
});

test('readQueue accepts an async provider and a { issues } wrapper', async () => {
  assert.deepEqual((await readQueue(async () => ({ issues: [7, 8] }))).items.map((i) => i.id), ['7', '8']);
});

test('readQueue reads a JSON file through the confinement and rejects escapes', async () => {
  const root = await tmp();
  const outside = await tmp();
  try {
    await writeFile(join(root, 'queue.json'), JSON.stringify([{ id: '10' }, { id: '11', state: 'done' }]));
    await writeFile(join(outside, 'q.json'), '[{"id":"99"}]');
    await symlink(outside, join(root, 'link'));
    const confinement = await createConfinement(root);
    assert.deepEqual((await readQueue('queue.json', { confinement })).items.map((i) => i.id), ['10']);
    await assert.rejects(readQueue('../q.json', { confinement }), PathEscapeError);
    await assert.rejects(readQueue('link/q.json', { confinement }), PathEscapeError);
    await assert.rejects(readQueue('queue.json'), TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('readQueue rejects ids that are not safe file names', async () => {
  for (const id of ['../x', 'a/b', '', '.hidden', 'a..b']) {
    await assert.rejects(readQueue([{ id }]), PathEscapeError, id);
  }
});

test('clean start: runQueue drives each issue through every phase to done, in queue order', async () => {
  const root = await tmp();
  try {
    const calls = [];
    const result = await runQueue({ workRoot: root, queue: [{ id: '2' }, { id: '1', priority: 1 }, { id: '3', state: 'done' }], handler: okHandler(calls) });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.outcomes.map((o) => [o.id, o.status]), [['1', 'done'], ['2', 'done']]);
    assert.deepEqual(calls.slice(0, 4), ['1:developing', '1:testing', '1:reviewing', '1:finalizing']);
    assert.deepEqual(result.skipped.map((s) => s.id), ['3']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a durably terminal issue is not woken again even if the source still lists it as queued', async () => {
  const root = await tmp();
  try {
    await runQueue({ workRoot: root, queue: ['1'], handler: okHandler() });
    const calls = [];
    const again = await runQueue({ workRoot: root, queue: ['1'], handler: okHandler(calls) });
    assert.deepEqual(calls, []);
    assert.equal(again.outcomes[0].skipped, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('queue read cannot follow an ancestor swapped after validation', async () => {
  const root = await tmp();
  const outside = await tmp();
  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue', 'items.json'), '[{"id":"inside"}]');
    await writeFile(join(outside, 'items.json'), '[{"id":"outside"}]');
    const confinement = await createConfinement(root);
    const original = confinement.resolve;
    confinement.resolve = async (...parts) => {
      const path = await original(...parts);
      await fs.rename(join(root, 'queue'), join(root, 'moved'));
      await symlink(outside, join(root, 'queue'));
      return path;
    };
    const result = await readQueue('queue/items.json', { confinement }).catch(() => null);
    assert.notEqual(result?.items[0]?.id, 'outside');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
