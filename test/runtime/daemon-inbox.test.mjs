import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { produceEvents } from '../../runtime/lib/daemon-events.mjs';
import { cycleSteps, runLoop } from '../../runtime/lib/daemon-loop.mjs';
import { openInbox, INBOX_PATH } from '../../runtime/lib/event-inbox.mjs';
import { openTimers, waitRelease } from '../../runtime/lib/event-timers.mjs';
import { createWakeSignal } from '../../runtime/lib/event-wake.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (ms) => new Date(T0 + ms).toISOString();

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-inbox-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// Fake GitHub reader: the observations are fixed data, no network.
const fakeReader = ({ issues = [], comments = {}, checks } = {}) => {
  const reader = {
    listIssues: async () => issues,
    listComments: async (n) => comments[n] ?? [],
  };
  if (checks) reader.listChecks = async (n) => checks[n] ?? [];
  return reader;
};

const issue = { number: 7, title: 'Build it', updatedAt: at(2000) };
const comment = { id: 'IC_1', body: 'please proceed', createdAt: at(1500) };

test('produceEvents turns issues, comments and checks into intake, owner_comment and ci events', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    const reader = fakeReader({ issues: [issue], comments: { 7: [comment] }, checks: { 7: [{ suite: 'unit', conclusion: 'success' }] } });
    await produceEvents({ inbox, reader });
    const events = inbox.events().map(({ source_event_id, kind, issue }) => ({ source_event_id, kind, issue }));
    assert.deepEqual(events, [
      { source_event_id: 'gh-issue:7:2026-01-01T00:00:02.000Z', kind: 'intake', issue: 7 },
      { source_event_id: 'gh-comment:IC_1', kind: 'owner_comment', issue: 7 },
      { source_event_id: 'gh-check:unit:success', kind: 'ci', issue: 7 },
    ]);
  });
});

test('producing the same observations twice appends nothing new', async () => {
  await withRoot(async (root) => {
    const reader = fakeReader({ issues: [issue], comments: { 7: [comment] }, checks: { 7: [{ suite: 'unit', conclusion: 'success' }] } });
    await produceEvents({ inbox: openInbox(root), reader });
    const file = join(root, INBOX_PATH);
    const before = readFileSync(file, 'utf8');
    await produceEvents({ inbox: openInbox(root), reader });
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(openInbox(root).events().length, 3);
  });
});

test('since keeps only observations newer than the given time, as an ISO string or epoch', async () => {
  await withRoot(async (root) => {
    const reader = fakeReader({ issues: [issue], comments: { 7: [comment] } });
    await produceEvents({ inbox: openInbox(root), reader, since: at(1000) });
    assert.deepEqual(openInbox(root).events().map((e) => e.source_event_id), ['gh-issue:7:2026-01-01T00:00:02.000Z', 'gh-comment:IC_1']);
    await produceEvents({ inbox: openInbox(root), reader, since: T0 + 1800 });
    assert.equal(openInbox(root).events().length, 2);
  });
});

test('a reader without listChecks produces no ci events', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    await produceEvents({ inbox, reader: fakeReader({ issues: [issue] }) });
    assert.deepEqual(inbox.events().map((e) => e.kind), ['intake']);
  });
});

test('one cycle dispatches three events of one issue as exactly one line batch', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    for (const [id, kind] of [['a', 'intake'], ['b', 'owner_comment'], ['c', 'ci']]) {
      inbox.accept({ source_event_id: id, kind, issue: 7, payload: {}, receivedAt: T0 });
    }
    const batches = [];
    await cycleSteps({ root, inbox: openInbox(root), timers: openTimers(root), now: T0, dispatchLine: (batch) => batches.push(batch) });
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].events.map((e) => e.source_event_id), ['a', 'b', 'c']);
  });
});

test('a wait frees its line; when the timer is due the next cycle dispatches the line with the heartbeat event', async () => {
  await withRoot(async (root) => {
    openInbox(root).accept({ source_event_id: 'intake-7', kind: 'intake', issue: 7, payload: {}, receivedAt: T0 });
    const dispatched = [];
    const cycle = (now) => cycleSteps({ root, inbox: openInbox(root), timers: openTimers(root), now, dispatchLine: (batch) => {
      dispatched.push(batch);
      if (batch.kind === 'intake') waitRelease(root, { issue: 7, input: { decision: 'wait', event: 'ci', unblockAt: at(1000) } });
    } });
    await cycle(T0);
    assert.equal(dispatched.length, 1);
    await cycle(T0 + 999);
    assert.equal(dispatched.length, 1, 'line is not dispatched before the timer is due');
    await cycle(T0 + 1000);
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[1].kind, 'heartbeat');
    assert.equal(dispatched[1].issue, 7);
  });
});

test('an inbox write during the inter-cycle wait ends the wait early', async (t) => {
  await withRoot(async (root) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const wake = createWakeSignal();
    const ac = new AbortController();
    const inbox = openInbox(root, { onWrite: () => wake.notify() });
    let passes = 0;
    const loop = runLoop({
      pass: async () => {
        if (++passes === 1) setImmediate(() => inbox.accept({ source_event_id: 'late', kind: 'intake', issue: 7, payload: {}, receivedAt: T0 }));
        if (passes === 2) ac.abort();
      },
      pollMs: 60_000, cycleDeadlineMs: 120_000, workRoot: root, baseWorkers: 1, wake, signal: ac.signal,
    });
    await settle();
    assert.equal(passes, 2, 'the write ended the wait without advancing the timer');
    await loop;
  });
});

test('without an inbox write the loop waits the full poll', async (t) => {
  await withRoot(async (root) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const wake = createWakeSignal();
    const ac = new AbortController();
    let passes = 0;
    const loop = runLoop({
      pass: async () => { passes++; },
      pollMs: 60_000, cycleDeadlineMs: 120_000, workRoot: root, baseWorkers: 1, wake, signal: ac.signal,
    });
    await settle();
    assert.equal(passes, 1);
    t.mock.timers.tick(59_999);
    await settle();
    assert.equal(passes, 1, 'still waiting one millisecond before the poll ends');
    t.mock.timers.tick(1);
    await settle();
    assert.equal(passes, 2);
    ac.abort();
    t.mock.timers.tick(60_000);
    await loop;
  });
});
