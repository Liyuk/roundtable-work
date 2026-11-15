import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInbox, INBOX_PATH } from '../../runtime/lib/event-inbox.mjs';
import { processPending, coalesce, openClaims } from '../../runtime/lib/event-claim.mjs';
import { createWakeSignal } from '../../runtime/lib/event-wake.mjs';

const event = (over = {}) => ({
  source_event_id: 'evt-1', kind: 'ci', issue: 266, payload: { ok: true }, receivedAt: 1000, ...over,
});

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-status-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const records = (root) => readFileSync(join(root, INBOX_PATH), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('accept stores when, what and session derived from receivedAt, kind, payload and issue', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    inbox.accept(event());
    inbox.accept(event({ source_event_id: 'h', kind: 'heartbeat', issue: null, payload: {} }));
    inbox.accept(event({ source_event_id: 'c', kind: 'owner_comment', issue: null, payload: { chatId: 42, text: 'hi' } }));
    inbox.accept(event({ source_event_id: 'n', kind: 'webhook', issue: null, payload: {} }));
    const [a, h, c, n] = inbox.events();
    assert.equal(a.when, 1000);
    assert.equal(a.what, 'ci {"ok":true}');
    assert.equal(a.session, 'issue:266');
    assert.equal(h.what, 'heartbeat {}');
    assert.equal(h.session, 'none');
    assert.equal(c.session, 'chat:42');
    assert.equal(n.session, 'none');
  });
});

test('what is one line of at most 120 code points', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    inbox.accept(event({ payload: { text: 'x'.repeat(300) + '\n' + '😀'.repeat(200) } }));
    const [stored] = inbox.events();
    assert.equal(stored.what.includes('\n'), false);
    assert.equal([...stored.what].length, 120);
    assert.equal(stored.what.startsWith('ci {"text":"xxx'), true);
  });
});

test('status changes are appended as status lines and statusOf reports them', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    inbox.accept(event());
    assert.equal(inbox.statusOf('evt-1'), 'pending');
    inbox.setStatus('evt-1', 'claimed');
    inbox.setStatus('evt-1', 'done');
    const lines = records(root).filter((r) => r.type === 'status');
    assert.deepEqual(lines.map((r) => [r.id, r.status]), [['evt-1', 'claimed'], ['evt-1', 'done']]);
    assert.equal(typeof lines[0].at, 'number');
    assert.equal(openInbox(root).statusOf('evt-1'), 'done');
    assert.equal(openInbox(root).events().length, 1);
  });
});

test('a duplicate appends one dropped record pointing at the original and leaves its status unchanged', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    inbox.accept(event());
    inbox.setStatus('evt-1', 'claimed');
    assert.equal(inbox.accept(event({ receivedAt: 2000 })), false);
    const dropped = records(root).filter((r) => r.type === 'dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].original, 'evt-1');
    assert.equal(openInbox(root).statusOf('evt-1'), 'claimed');
    assert.equal(openInbox(root).events().length, 1);
  });
});

test('a dropped record is never dispatched', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    inbox.accept(event());
    inbox.accept(event());
    const batches = [];
    await processPending(root, (batch) => batches.push(batch.events.map((e) => e.source_event_id)));
    assert.deepEqual(batches, [['evt-1']]);
  });
});

test('records without status lines read as done when acked, otherwise pending', async () => {
  await withRoot(async (root) => {
    const legacy = (id) => JSON.stringify({ source_event_id: id, kind: 'ci', issue: 5, payload: {}, receivedAt: 1 });
    mkdirSync(join(root, '.roundtable/state'), { recursive: true });
    writeFileSync(join(root, INBOX_PATH), legacy('old-acked') + '\n' + legacy('old-open') + '\n');
    writeFileSync(join(root, '.roundtable/state/acked.jsonl'), 'old-acked\n');
    const inbox = openInbox(root);
    assert.equal(inbox.statusOf('old-acked'), 'done');
    assert.equal(inbox.statusOf('old-open'), 'pending');
  });
});

test('coalesce groups by session: one issue with three kinds is one batch; session none stays one per event', () => {
  const groups = coalesce([
    event({ source_event_id: 'a', kind: 'ci', issue: 7, session: 'issue:7' }),
    event({ source_event_id: 'b', kind: 'owner_comment', issue: 7, session: 'issue:7' }),
    event({ source_event_id: 'c', kind: 'intake', issue: 7, session: 'issue:7' }),
    event({ source_event_id: 'd', kind: 'heartbeat', issue: null, session: 'none' }),
    event({ source_event_id: 'e', kind: 'heartbeat', issue: null, session: 'none' }),
  ]);
  assert.deepEqual(groups.map((g) => g.events.map((e) => e.source_event_id)), [['a', 'b', 'c'], ['d'], ['e']]);
});

test('coalesce derives session for raw events that lack it', () => {
  const groups = coalesce([
    event({ source_event_id: 'a', kind: 'ci', issue: 3 }),
    event({ source_event_id: 'b', kind: 'owner_comment', issue: 3 }),
    event({ source_event_id: 'c', kind: 'heartbeat', issue: null, payload: {} }),
  ]);
  assert.deepEqual(groups.map((g) => g.events.map((e) => e.source_event_id)), [['a', 'b'], ['c']]);
});

test('when dispatch throws, claims are released, events stay pending, and the rethrow is seen', async () => {
  await withRoot(async (root) => {
    openInbox(root).accept(event({ source_event_id: 'a' }));
    openInbox(root).accept(event({ source_event_id: 'b', kind: 'heartbeat', issue: null, payload: {} }));
    await assert.rejects(processPending(root, () => { throw new Error('boom'); }), /boom/);
    assert.equal(existsMarker(root, 'applied.jsonl'), false);
    assert.equal(existsMarker(root, 'acked.jsonl'), false);
    assert.equal(openInbox(root).statusOf('a'), 'pending');
    assert.equal(openInbox(root).statusOf('b'), 'pending');
    const dispatched = [];
    await processPending(root, (batch) => dispatched.push(...batch.events.map((e) => e.source_event_id)));
    assert.deepEqual(dispatched, ['a', 'b']);
    assert.equal(openInbox(root).statusOf('a'), 'done');
  });
});

const existsMarker = (root, name) => {
  try { return readFileSync(join(root, '.roundtable/state', name), 'utf8').length > 0; } catch { return false; }
};

test('openInbox calls onWrite after each durable append, including status and dropped records', async () => {
  await withRoot(async (root) => {
    let writes = 0;
    const inbox = openInbox(root, { onWrite: () => { writes++; } });
    inbox.accept(event());
    assert.equal(writes, 1);
    inbox.accept(event());
    assert.equal(writes, 2);
    inbox.setStatus('evt-1', 'done');
    assert.equal(writes, 3);
  });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('createWakeSignal: notify resolves a waiting wait early; otherwise wait resolves after ms', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wake = createWakeSignal();
  const early = wake.wait(5000);
  wake.notify();
  await early;

  let late = false;
  const timed = wake.wait(5000).then(() => { late = true; });
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(late, false);
  t.mock.timers.tick(1);
  await timed;
  assert.equal(late, true);
});

test('a claim released after a failed dispatch can be claimed again in the same process', async () => {
  await withRoot(async (root) => {
    openInbox(root).accept(event({ source_event_id: 'a' }));
    await assert.rejects(processPending(root, () => { throw new Error('x'); }));
    assert.equal(openClaims(root).claim('a'), 'claimed');
  });
});
