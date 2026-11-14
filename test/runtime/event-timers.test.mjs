import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorkers } from '../../runtime/lib/workers.mjs';
import { openInbox, matchEvents } from '../../runtime/lib/event-inbox.mjs';
import { openTimers, waitRelease, TIMERS_PATH } from '../../runtime/lib/event-timers.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (ms) => new Date(T0 + ms).toISOString();

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'timers-test-'));
  const anchor = mkdtempSync(join(tmpdir(), 'timers-anchor-'));
  process.env.RTW_STATE_DIR = anchor;
  try { await fn(root); } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(anchor, { recursive: true, force: true });
  }
};

test('timers live in their own file, separate from the event inbox', async () => {
  await withRoot((root) => {
    openTimers(root).once({ id: 't1', at: at(1000), event: { kind: 'heartbeat', issue: 5, payload: {} } });
    assert.equal(TIMERS_PATH, '.roundtable/state/timers.json');
    assert.equal(openInbox(root).events().length, 0);
  });
});

test('a one-shot timer fires once into the inbox and is then removed', async () => {
  await withRoot((root) => {
    const timers = openTimers(root);
    timers.once({ id: 't1', at: at(1000), event: { kind: 'heartbeat', issue: 5, payload: { why: 'follow-up' } } });
    assert.equal(timers.fire(T0 + 500), 0);
    assert.equal(timers.fire(T0 + 1000), 1);
    assert.equal(timers.fire(T0 + 5000), 0);
    assert.deepEqual(timers.list(), []);
    const [e] = openInbox(root).events();
    assert.equal(e.kind, 'heartbeat');
    assert.equal(e.issue, 5);
    assert.deepEqual(e.payload, { why: 'follow-up' });
    assert.equal(e.source_event_id, `timer:t1:${T0 + 1000}`);
  });
});

test('a recurring timer keeps firing on its cadence, one inbox event per firing', async () => {
  await withRoot((root) => {
    const timers = openTimers(root);
    timers.recurring({ id: 'r1', at: at(100), cadenceMs: 100, event: { kind: 'heartbeat', issue: null, payload: {} } });
    assert.equal(timers.fire(T0 + 100), 1);
    assert.equal(timers.fire(T0 + 199), 0);
    assert.equal(timers.fire(T0 + 300), 2);
    assert.equal(timers.list().length, 1);
    const ids = openInbox(root).events().map((e) => e.source_event_id);
    assert.deepEqual(ids, [`timer:r1:${T0 + 100}`, `timer:r1:${T0 + 200}`, `timer:r1:${T0 + 300}`]);
  });
});

test('re-firing the same occurrence does not duplicate the inbox event', async () => {
  await withRoot((root) => {
    const timers = openTimers(root);
    timers.recurring({ id: 'r1', at: at(100), cadenceMs: 100, event: { kind: 'heartbeat', issue: null, payload: {} } });
    timers.fire(T0 + 100);
    openTimers(root).recurring({ id: 'r1', at: at(100), cadenceMs: 100, event: { kind: 'heartbeat', issue: null, payload: {} } });
    openTimers(root).fire(T0 + 100);
    assert.equal(openInbox(root).events().length, 1);
  });
});

test('fake clock: while a worker waits for CI its slot is free and the CI event resumes the line', async () => {
  await withRoot(async (root) => {
    let clock = T0;
    const now = () => clock;
    const started = [];
    const issues = [{ number: 1 }, { number: 2 }];
    const run = async (issue, { id }) => {
      started.push(id);
      if (id === '1') {
        waitRelease(root, { issue: 1, input: { decision: 'wait', event: 'ci', unblockAt: at(60_000) } });
      }
    };
    const result = await runWorkers({ issues, workRoot: root, repoRoot: root, workers: 1, run, now });
    assert.deepEqual(started, ['1', '2'], 'second issue starts while the first is waiting');
    assert.deepEqual(result.failed, []);

    clock += 10_000;
    openInbox(root).accept({ source_event_id: 'ci-done-1', kind: 'ci', issue: 1, payload: { conclusion: 'success' }, receivedAt: clock });
    const { routed } = matchEvents(openInbox(root).events(), new Map([[1, 'line-1']]));
    assert.deepEqual(routed, [{ source_event_id: 'ci-done-1', line: 'line-1' }]);
  });
});

test('fake clock: a due wait timer wakes the line through an inbox event after its slot was released', async () => {
  await withRoot(async (root) => {
    let clock = T0;
    const started = [];
    const run = async (issue, { id }) => {
      started.push(id);
      if (id === '1') waitRelease(root, { issue: 1, input: { decision: 'wait', event: 'ci', unblockAt: at(1000) } });
    };
    await runWorkers({ issues: [{ number: 1 }, { number: 2 }], workRoot: root, repoRoot: root, workers: 1, run, now: () => clock });
    assert.deepEqual(started, ['1', '2']);
    assert.equal(openInbox(root).events().length, 0);

    clock = T0 + 1000;
    openTimers(root).fire(clock);
    const [e] = openInbox(root).events();
    assert.equal(e.issue, 1);
    assert.equal(matchEvents([e], new Map([[1, 'line-1']])).routed.length, 1);
  });
});

test('wait release rejects a wait without an event binding or unblock time', async () => {
  await withRoot((root) => {
    assert.throws(() => waitRelease(root, { issue: 1, input: { decision: 'wait', unblockAt: at(1) } }), /WAIT_NO_EVENT|event binding/);
    assert.throws(() => waitRelease(root, { issue: 1, input: { decision: 'wait', event: 'ci' } }), /WAIT_NO_UNBLOCK|unblock/);
  });
});
