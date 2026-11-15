import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPoller, nextIntervalMs, openPollStore, resolveMode, RECONCILE_MS, sourceEventId } from '../../runtime/lib/github-poll.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { cycleSteps } from '../../runtime/lib/daemon-loop.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 15_000;
const MAX = 900_000;
const issue = { number: 7, title: 'Build it', updatedAt: '2026-01-01T00:00:02.000Z' };
const normalize = (items) => items.map((item) => ({
  source_event_id: sourceEventId('issue', item), kind: 'intake', issue: item.number, payload: { title: item.title },
}));
const ok = (body, extra = {}) => ({ status: 200, etag: 'W/"v1"', headers: {}, body, ...extra });
const notModified = { status: 304, etag: 'W/"v1"', headers: {}, body: null };

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'github-poll-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// Stubbed request: returns the queued responses in order and records what was asked.
const stubRequest = (responses) => {
  const calls = [];
  const request = async (args) => {
    calls.push(args);
    return responses.shift();
  };
  return { request, calls };
};

const makePoller = (root, { request, clock = { t: T0 }, ...rest }) => {
  const inbox = openInbox(root);
  const store = openPollStore(root);
  const poller = createPoller({ request, store, inbox, toEvents: normalize, now: () => clock.t, minMs: MIN, maxMs: MAX, ...rest });
  return { poller, inbox, store };
};

test('A1: a 304 Not Modified produces no events and does not change the cursor', async () => {
  await withRoot(async (root) => {
    const { request, calls } = stubRequest([ok([issue]), notModified]);
    const { poller, inbox, store } = makePoller(root, { request });
    await poller.poll('/repos/o/r/issues');
    const before = store.read();
    const eventsBefore = inbox.events().length;

    const result = await poller.poll('/repos/o/r/issues');

    assert.equal(result.status, 304);
    assert.equal(result.accepted, 0);
    assert.equal(calls[1].etag, 'W/"v1"');
    assert.equal(openInbox(root).events().length, eventsBefore);
    assert.deepEqual(store.read(), before);
  });
});

test('A2: the same change seen by webhook and by poll yields one inbox event', async () => {
  await withRoot(async (root) => {
    const { request } = stubRequest([ok([issue])]);
    const { poller, inbox } = makePoller(root, { request });
    // Webhook path: the id comes from the same shared helper the poller uses.
    inbox.accept({
      source_event_id: sourceEventId('issue', issue), kind: 'webhook', issue: 7, payload: { title: issue.title }, receivedAt: T0,
    });

    const result = await poller.poll('/repos/o/r/issues');

    assert.equal(result.accepted, 0);
    assert.deepEqual(openInbox(root).events().map((e) => e.source_event_id), ['gh-issue:7:2026-01-01T00:00:02.000Z']);
  });
});

test('sourceEventId keeps the ids daemon-events already uses', () => {
  assert.equal(sourceEventId('issue', { number: 7, updatedAt: '2026-01-01T00:00:02.000Z' }), 'gh-issue:7:2026-01-01T00:00:02.000Z');
  assert.equal(sourceEventId('comment', { id: 'IC_1' }), 'gh-comment:IC_1');
  assert.equal(sourceEventId('check', { suite: 'unit', conclusion: 'success' }), 'gh-check:unit:success');
});

test('A3: the interval backs off while idle, tightens after an event, and never exceeds the rate-limit budget', () => {
  const base = { minMs: MIN, maxMs: MAX, now: T0, resetAt: T0 + 60_000 };
  // Idle (no event for an hour): the interval doubles from its current value up to maxMs.
  assert.equal(nextIntervalMs({ ...base, currentMs: MIN, sinceEventMs: 3_600_000 }), 2 * MIN);
  assert.equal(nextIntervalMs({ ...base, currentMs: MAX, sinceEventMs: 3_600_000 }), MAX);
  // Right after a new event the interval is back at minMs.
  assert.equal(nextIntervalMs({ ...base, currentMs: MAX, sinceEventMs: 0 }), MIN);
  // Low remaining budget: wait until the reset.
  assert.equal(nextIntervalMs({ ...base, currentMs: MIN, sinceEventMs: 0, remaining: 5 }), 60_000);
  // retry-after is respected.
  assert.equal(nextIntervalMs({ ...base, currentMs: MIN, sinceEventMs: 0, retryAfterMs: 120_000 }), 120_000);
});

const HOUR = 3_600_000;

test('A3: poll-driven intervals back off through idle 304 responses and stay within the budget', async () => {
  await withRoot(async (root) => {
    const clock = { t: T0 };
    const { request } = stubRequest([notModified, notModified, notModified, notModified]);
    const { poller } = makePoller(root, { request, clock });
    const intervals = [];
    for (let i = 0; i < 4; i++) {
      clock.t += HOUR;
      intervals.push((await poller.poll('/repos/o/r/issues')).nextMs);
    }
    assert.deepEqual(intervals, [2 * MIN, 4 * MIN, 8 * MIN, 16 * MIN]);
  });
});

test('A3: remaining budget at the floor makes the next poll wait until the rate-limit reset', async () => {
  await withRoot(async (root) => {
    const clock = { t: T0 + 5 * HOUR };
    const low = { status: 304, etag: 'W/"v1"', headers: { remaining: 3, resetAt: clock.t + 5 * 60_000 }, body: null };
    const { request } = stubRequest([low]);
    const { poller } = makePoller(root, { request, clock });
    assert.equal((await poller.poll('/repos/o/r/issues')).nextMs, 5 * 60_000);
  });
});

test('A3: a new event brings the poll interval back to minMs after idle backoff', async () => {
  await withRoot(async (root) => {
    const clock = { t: T0 };
    const { request } = stubRequest([notModified, notModified, ok([issue])]);
    const { poller } = makePoller(root, { request, clock });
    clock.t += HOUR;
    assert.equal((await poller.poll('/repos/o/r/issues')).nextMs, 2 * MIN);
    clock.t += HOUR;
    assert.equal((await poller.poll('/repos/o/r/issues')).nextMs, 4 * MIN);
    clock.t += 1000;
    const result = await poller.poll('/repos/o/r/issues');
    assert.equal(result.accepted, 1);
    assert.equal(result.nextMs, MIN);
  });
});

test('resolveMode: poll without a listener, hybrid by default with one, explicit webhook needs a listener', () => {
  assert.equal(resolveMode(undefined, { listenerConfigured: false }), 'poll');
  assert.equal(resolveMode(undefined, { listenerConfigured: true }), 'hybrid');
  assert.equal(resolveMode('webhook', { listenerConfigured: false }), 'poll');
  assert.equal(resolveMode('webhook', { listenerConfigured: true }), 'webhook');
  assert.throws(() => resolveMode('fast', { listenerConfigured: true }), TypeError);
});

test('A4: a hybrid reconciliation poll recovers a change the webhook never delivered, exactly once', async () => {
  await withRoot(async (root) => {
    // The webhook delivery for this issue was dropped, so the inbox has nothing for it.
    const { request } = stubRequest([ok([issue]), ok([issue])]);
    const { poller, inbox } = makePoller(root, { request, minMs: RECONCILE_MS, maxMs: RECONCILE_MS });
    const first = await poller.poll('/repos/o/r/issues');
    const second = await poller.poll('/repos/o/r/issues');
    assert.equal(first.accepted, 1);
    assert.equal(second.accepted, 0);
    assert.equal(first.nextMs, RECONCILE_MS);
    assert.deepEqual(openInbox(root).events().map((e) => e.source_event_id), ['gh-issue:7:2026-01-01T00:00:02.000Z']);
    assert.equal(inbox.events().length, 1);
  });
});

// Daemon-cycle tests: the poll option of cycleSteps, driven with the same injected clock as the poller.
const pollCycle = (root, { mode, poller, clock, lastPollAt = T0, intervalMs = MIN, batches = [] }) => {
  const poll = { mode, poller, paths: ['/repos/o/r/issues'], lastPollAt, intervalMs };
  return (now) => {
    clock.t = now;
    return cycleSteps({ root, inbox: openInbox(root), timers: openTimers(root), now, poll, dispatchLine: (batch) => batches.push(batch) });
  };
};

test('A4: hybrid mode, webhook delivery dropped: the daemon cycle reconciliation poll recovers the change exactly once', async () => {
  await withRoot(async (root) => {
    const clock = { t: T0 };
    const { request, calls } = stubRequest([ok([issue]), ok([issue])]);
    const { poller } = makePoller(root, { request, clock });
    const batches = [];
    const cycle = pollCycle(root, { mode: resolveMode(undefined, { listenerConfigured: true }), poller, clock, batches });

    await cycle(T0 + RECONCILE_MS - 1);
    assert.equal(calls.length, 0);
    await cycle(T0 + RECONCILE_MS);
    assert.equal(calls.length, 1);
    assert.deepEqual(batches.flatMap((b) => b.events.map((e) => e.source_event_id)), ['gh-issue:7:2026-01-01T00:00:02.000Z']);

    await cycle(T0 + 2 * RECONCILE_MS);
    assert.equal(calls.length, 2);
    assert.equal(batches.length, 1);
    assert.equal(openInbox(root).events().length, 1);
  });
});

test('cycleSteps poll cadence: mode webhook never polls; mode poll polls on the minMs cadence', async () => {
  await withRoot(async (root) => {
    const clock = { t: T0 };
    const webhook = stubRequest([]);
    const hook = pollCycle(root, { mode: 'webhook', poller: makePoller(root, { request: webhook.request, clock }).poller, clock });
    await hook(T0 + 10 * HOUR);
    assert.equal(webhook.calls.length, 0);

    const polled = stubRequest([notModified, notModified]);
    const cycle = pollCycle(root, { mode: 'poll', poller: makePoller(root, { request: polled.request, clock }).poller, clock });
    await cycle(T0);
    assert.equal(polled.calls.length, 0);
    await cycle(T0 + MIN);
    await cycle(T0 + MIN + 1000);
    assert.equal(polled.calls.length, 1);
    await cycle(T0 + 2 * MIN);
    assert.equal(polled.calls.length, 2);
  });
});

test('nextIntervalMs never returns a negative delay when the reset is already past', () => {
  assert.equal(nextIntervalMs({ currentMs: MIN, sinceEventMs: 0, minMs: MIN, maxMs: MAX, remaining: 0, resetAt: T0 - 1000, now: T0 }), 0);
});
