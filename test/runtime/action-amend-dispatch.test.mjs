import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDispatchLine } from '../../runtime/lib/daemon-cards.mjs';
import { cycleSteps } from '../../runtime/lib/daemon-loop.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const OWNER = 'octo-owner';

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'action-amend-dispatch-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const ownerComment = (id, payload) => ({ source_event_id: id, kind: 'owner_comment', issue: 7, payload, receivedAt: T0 });
const amendPayload = { command: 'amend', actionId: 'act:x:7:k', text: 'use a smaller diff', sessionId: 'sess-7', author: OWNER };

test('an amend owner_comment calls resume exactly once with the stored sessionId and text', async () => {
  await withRoot(async (root) => {
    const calls = [];
    const dispatchLine = makeDispatchLine({ root, owner: OWNER, resume: async (args) => calls.push(args) });
    await dispatchLine({ issue: 7, events: [ownerComment('amend:act:x:7:k', amendPayload)] });
    assert.deepEqual(calls, [{ root, issue: 7, sessionId: 'sess-7', text: 'use a smaller diff', actionId: 'act:x:7:k' }]);
  });
});

test('a non-amend owner_comment does not call resume', async () => {
  await withRoot(async (root) => {
    const calls = [];
    const dispatchLine = makeDispatchLine({ root, owner: OWNER, resume: async (args) => calls.push(args) });
    await dispatchLine({ issue: 7, events: [ownerComment('c-1', { body: 'hello', author: OWNER })] });
    await dispatchLine({ issue: 7, events: [ownerComment('c-2', { command: 'confirm', actionId: 'act:x:7:k', author: OWNER })] });
    assert.deepEqual(calls, []);
  });
});

test('an amend reply accepted by the inbox is dispatched through resume with its sessionId and text', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    inbox.accept(ownerComment('amend:act:x:7:k', amendPayload));
    const calls = [];
    const dispatchLine = makeDispatchLine({ root, owner: OWNER, resume: async (args) => calls.push(args) });
    await cycleSteps({ root, inbox, timers: openTimers(root), now: T0, dispatchLine });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, 'sess-7');
    assert.equal(calls[0].text, 'use a smaller diff');
  });
});
