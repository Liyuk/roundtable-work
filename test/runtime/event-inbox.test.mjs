import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInbox, matchEvents, INBOX_PATH } from '../../runtime/lib/event-inbox.mjs';

const event = (over = {}) => ({
  source_event_id: 'evt-1', kind: 'ci', issue: 266, payload: { ok: true }, receivedAt: 1000, ...over,
});

const withRoot = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'inbox-test-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('the inbox path is the fixed event inbox state file', () => {
  assert.equal(INBOX_PATH, '.roundtable/state/event-inbox.jsonl');
});

test('the same source_event_id delivered twice is stored exactly once', () => {
  withRoot((root) => {
    const inbox = openInbox(root);
    assert.equal(inbox.accept(event()), true);
    assert.equal(inbox.accept(event({ payload: { ok: false }, receivedAt: 2000 })), false);
    assert.equal(inbox.events().length, 1);
    assert.deepEqual(inbox.events()[0], event());
    const lines = readFileSync(join(root, INBOX_PATH), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
  });
});

test('the inbox survives restart with the same content', () => {
  withRoot((root) => {
    openInbox(root).accept(event());
    openInbox(root).accept(event({ source_event_id: 'evt-2', kind: 'heartbeat', issue: null, payload: {} }));
    const reopened = openInbox(root);
    assert.deepEqual(reopened.events(), [
      event(),
      event({ source_event_id: 'evt-2', kind: 'heartbeat', issue: null, payload: {} }),
    ]);
    assert.equal(reopened.accept(event()), false);
  });
});

test('accept rejects an invalid event with a TypeError', () => {
  withRoot((root) => {
    const inbox = openInbox(root);
    assert.throws(() => inbox.accept(event({ source_event_id: '' })), TypeError);
    assert.throws(() => inbox.accept(event({ kind: 'email' })), TypeError);
    assert.throws(() => inbox.accept(event({ issue: 0 })), TypeError);
    assert.throws(() => inbox.accept(event({ issue: 1.5 })), TypeError);
    assert.throws(() => inbox.accept(event({ payload: null })), TypeError);
    assert.throws(() => inbox.accept(event({ receivedAt: '1' })), TypeError);
    assert.equal(inbox.events().length, 0);
  });
});

test('matchEvents routes each event to its issue line and keeps unmatched events', () => {
  const events = [
    event({ source_event_id: 'a', issue: 266 }),
    event({ source_event_id: 'b', issue: 999 }),
    event({ source_event_id: 'c', issue: null, kind: 'heartbeat' }),
  ];
  const result = matchEvents(events, new Map([[266, 'line-x']]));
  assert.deepEqual(result.routed, [{ source_event_id: 'a', line: 'line-x' }]);
  assert.deepEqual(result.unmatched.map((e) => e.source_event_id), ['b', 'c']);
  assert.equal(events.length, 3);
});
