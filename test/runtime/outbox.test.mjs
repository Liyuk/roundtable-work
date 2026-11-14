import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOutbox, dispatch, decideTurn, OUTBOX_PATH, KINDS, OUTCOMES } from '../../runtime/lib/outbox.mjs';

const item = (over = {}) => ({ id: 'item-1', kind: 'comment', issue: 286, payload: { body: 'hi' }, ...over });

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// Recording provider: applies the side effect once per id (idempotent by item id).
const recordingProvider = (effects) => ({
  async deliver({ id, kind }) {
    effects.push({ id, kind });
    return { ok: true, id };
  },
});

test('the outbox path and kinds are fixed', () => {
  assert.equal(OUTBOX_PATH, '.roundtable/state/outbox.jsonl');
  assert.deepEqual(KINDS, ['comment', 'label', 'merge', 'notification']);
});

for (const kind of KINDS) {
  test(`a ${kind} item is enqueued, delivered once, and receipted`, async () => {
    await withRoot(async (root) => {
      const outbox = openOutbox(root);
      const effects = [];
      assert.equal(outbox.enqueue(item({ id: `${kind}-1`, kind })), true);
      assert.equal(outbox.pending().length, 1);
      const result = await dispatch({ outbox, provider: recordingProvider(effects) });
      assert.deepEqual(result, { delivered: [`${kind}-1`], failed: [] });
      assert.deepEqual(effects, [{ id: `${kind}-1`, kind }]);
      assert.deepEqual(outbox.pending(), []);
      assert.deepEqual(outbox.receipts().get(`${kind}-1`), { ok: true, id: `${kind}-1` });
    });
  });
}

test('enqueue rejects invalid items with a TypeError and writes nothing', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    assert.throws(() => outbox.enqueue(item({ id: '' })), TypeError);
    assert.throws(() => outbox.enqueue(item({ kind: 'email' })), TypeError);
    assert.throws(() => outbox.enqueue(item({ issue: 0 })), TypeError);
    assert.throws(() => outbox.enqueue(item({ issue: 1.5 })), TypeError);
    assert.throws(() => outbox.enqueue(item({ payload: null })), TypeError);
    assert.equal(outbox.items().length, 0);
  });
});

test('a duplicate item id is not enqueued again', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    assert.equal(outbox.enqueue(item()), true);
    assert.equal(outbox.enqueue(item({ payload: { body: 'other' } })), false);
    assert.equal(outbox.items().length, 1);
    assert.deepEqual(outbox.items()[0], item());
  });
});

test('restart keeps items and receipts, and undelivered items stay pending', async () => {
  await withRoot(async (root) => {
    const first = openOutbox(root);
    first.enqueue(item({ id: 'a' }));
    first.enqueue(item({ id: 'b', kind: 'label', issue: null, payload: { label: 'x' } }));
    first.markDelivered('a', { ok: true });
    const reopened = openOutbox(root);
    assert.deepEqual(reopened.items(), first.items());
    assert.deepEqual(reopened.receipts(), first.receipts());
    assert.deepEqual(reopened.pending().map((i) => i.id), ['b']);
  });
});

test('a lost acknowledgement is retried and the side effect is applied exactly once', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    outbox.enqueue(item({ id: 'x' }));
    outbox.enqueue(item({ id: 'y', kind: 'merge', payload: { pr: 1 } }));
    const applied = new Set();
    const sideEffects = [];
    const seenFirstCall = new Set();
    const provider = {
      async deliver({ id }) {
        if (!applied.has(id)) {
          applied.add(id);
          sideEffects.push(id);
        }
        if (!seenFirstCall.has(id)) {
          seenFirstCall.add(id);
          throw new Error('ack lost');
        }
        return { ok: true, id };
      },
    };
    const result = await dispatch({ outbox, provider });
    assert.deepEqual(result, { delivered: ['x', 'y'], failed: [] });
    assert.deepEqual(sideEffects.filter((id) => id === 'x'), ['x']);
    assert.deepEqual(sideEffects.filter((id) => id === 'y'), ['y']);
    assert.deepEqual(outbox.pending(), []);
    assert.equal(openOutbox(root).pending().length, 0);
  });
});

test('an item that keeps failing stays pending and dispatch moves on', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    outbox.enqueue(item({ id: 'bad' }));
    outbox.enqueue(item({ id: 'good' }));
    const calls = [];
    const provider = {
      async deliver({ id }) {
        calls.push(id);
        if (id === 'bad') throw new Error('down');
        return { ok: true };
      },
    };
    const result = await dispatch({ outbox, provider, maxAttempts: 2 });
    assert.deepEqual(result, { delivered: ['good'], failed: ['bad'] });
    assert.deepEqual(calls, ['bad', 'bad', 'good']);
    assert.deepEqual(outbox.pending().map((i) => i.id), ['bad']);
  });
});

test('decideTurn returns exactly one outcome for every input and follows the rules', () => {
  for (const wantsSideEffect of [false, true]) {
    for (const needsApproval of [false, true]) {
      for (const approved of [false, true]) {
        const outcome = decideTurn({ wantsSideEffect, needsApproval, approved });
        assert.ok(OUTCOMES.includes(outcome), `${outcome} not in OUTCOMES`);
        let expected;
        if (!wantsSideEffect) expected = 'do-not-send';
        else if (needsApproval && !approved) expected = 'suspend';
        else expected = 'send';
        assert.equal(outcome, expected);
      }
    }
  }
  assert.deepEqual(OUTCOMES, ['send', 'do-not-send', 'suspend']);
});
