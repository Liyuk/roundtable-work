import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOutbox, dispatch, noticeId } from '../../runtime/lib/outbox.mjs';
import { createGitHubOutboxProvider } from '../../runtime/lib/outbox-github.mjs';
import { createShadowGitHub } from '../../runtime/lib/shadow.mjs';

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-daemon-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('a failing item is backed off exponentially, dead after deadAfter failures, and raises one stall alert', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    outbox.enqueue({ id: 'bad', kind: 'comment', issue: 385, payload: { body: 'hi' } });
    let clock = 0;
    const calls = [];
    const provider = { async deliver({ id }) { if (id !== 'bad') return { ok: true }; calls.push(clock); throw new Error('down'); } };
    const run = () => dispatch({ outbox, provider, now: () => clock, backoffMs: 1000, deadAfter: 3 });
    await run(); // failure 1 at 0: next attempt after 1000 ms
    clock = 999; await run(); // still inside the window: skipped
    clock = 1000; await run(); // failure 2 at 1000: next attempt after 2000 ms more
    clock = 2999; await run(); // still inside the window: skipped
    assert.deepEqual(calls, [0, 1000]);
    clock = 3000; await run(); // failure 3: dead, one alert enqueued
    assert.deepEqual(calls, [0, 1000, 3000]);
    clock = 1e9; await run(); // dead items are never delivered again
    assert.deepEqual(calls, [0, 1000, 3000]);

    const reopened = openOutbox(root);
    assert.deepEqual(reopened.pending(), []);
    assert.deepEqual(reopened.items().filter((i) => i.kind === 'notification'), [{
      id: 'alert:dead:bad', kind: 'notification', issue: 385, payload: { subtype: 'stall-alert', of: 'bad' },
    }]);
    assert.equal(reopened.items().filter((i) => i.id === 'alert:dead:bad').length, 1);
  });
});

test('dispatch without backoff or deadAfter keeps retrying every cycle', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    outbox.enqueue({ id: 'bad', kind: 'comment', issue: 385, payload: { body: 'hi' } });
    const provider = { async deliver() { throw new Error('down'); } };
    for (let cycle = 0; cycle < 3; cycle++) await dispatch({ outbox, provider, maxAttempts: 1 });
    assert.equal(openOutbox(root).items().length, 1);
    assert.deepEqual(openOutbox(root).pending().map((i) => i.id), ['bad']);
  });
});

test('noticeId derives the id from the cause, and a notice with the same cause is enqueued once', async () => {
  assert.equal(noticeId({ kind: 'merge', pr: 12, head: 'abc' }), 'notice:merge:12:abc');
  assert.equal(noticeId({ kind: 'action', actionId: 'a1', state: 'executed_pending_confirmation' }), 'notice:action:a1:executed_pending_confirmation');
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    const notice = { id: noticeId({ kind: 'merge', pr: 12, head: 'abc' }), kind: 'notification', issue: 385, payload: { subtype: 'notice' } };
    assert.equal(outbox.enqueue(notice), true);
    assert.equal(outbox.enqueue(notice), false);
    assert.equal(openOutbox(root).items().length, 1);
  });
});

test('a comment whose acknowledgement was lost is posted exactly once', async () => {
  await withRoot(async (root) => {
    const comments = [];
    let lost = false;
    const writer = {
      listComments: async () => comments.map((body) => ({ body })),
      createComment: async (_issue, body) => {
        comments.push(body);
        if (!lost) { lost = true; throw new Error('ack lost'); }
      },
    };
    const outbox = openOutbox(root);
    outbox.enqueue({ id: 'c1', kind: 'comment', issue: 385, payload: { body: 'hello' } });
    const result = await dispatch({ outbox, provider: createGitHubOutboxProvider({ writer }) });
    assert.deepEqual(result, { delivered: ['c1'], failed: [] });
    assert.deepEqual(comments, ['<!-- rt:outbox c1 -->\nhello']);
  });
});

test('a label item is added through the writer', async () => {
  await withRoot(async (root) => {
    const added = [];
    const writer = { addLabel: async (issue, label) => { added.push([issue, label]); } };
    const outbox = openOutbox(root);
    outbox.enqueue({ id: 'l1', kind: 'label', issue: 385, payload: { label: 'rt:go' } });
    await dispatch({ outbox, provider: createGitHubOutboxProvider({ writer }) });
    assert.deepEqual(added, [[385, 'rt:go']]);
  });
});

test('shadow mode posts nothing: the provider writes through the shadow client', async () => {
  await withRoot(async (root) => {
    let posted = 0;
    const live = {
      listComments: async () => [],
      createComment: async () => { posted++; },
      addLabel: async () => { posted++; },
    };
    const attempted = [];
    const outbox = openOutbox(root);
    outbox.enqueue({ id: 'c1', kind: 'comment', issue: 385, payload: { body: 'hello' } });
    outbox.enqueue({ id: 'l1', kind: 'label', issue: 385, payload: { label: 'rt:go' } });
    const provider = createGitHubOutboxProvider({ writer: createShadowGitHub(live, attempted) });
    const result = await dispatch({ outbox, provider });
    assert.deepEqual(result, { delivered: ['c1', 'l1'], failed: [] });
    assert.equal(posted, 0);
    assert.deepEqual(attempted, ['createComment', 'addLabel']);
  });
});
