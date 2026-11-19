// Fixture tests for the host event producers: each of the six trigger kinds lands in the inbox with the expected
// kind, issue routing and source_event_id. No network: GitHub is a fake reader, the webhook uses a loopback listener
// bound by the test only, and the default host (rtd.mjs, daemon-loop.mjs) is checked statically.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { produceEvents } from '../../runtime/lib/daemon-events.mjs';
import { createHandler } from '../../runtime/lib/webhook-listener.mjs';
import { openInbox, sessionOf } from '../../runtime/lib/event-inbox.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { ensurePatrolTimer, PATROL_TIMER } from '../../runtime/lib/patrol-timer.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (ms) => new Date(T0 + ms).toISOString();

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'host-producers-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const summary = (inbox) => inbox.events().map(({ source_event_id, kind, issue }) => ({ source_event_id, kind, issue }));

test('intake, owner_comment and ci events are produced from GitHub observations with issue routing', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    const reader = {
      listIssues: async () => [{ number: 7, title: 'Build it', updatedAt: at(2000) }],
      listComments: async () => [{ id: 'IC_1', body: 'approve', createdAt: at(1500), author: { login: 'owner' } }],
      listChecks: async () => [{ suite: 'unit', conclusion: 'success' }],
    };
    await produceEvents({ inbox, reader });
    assert.deepEqual(summary(inbox), [
      { source_event_id: `gh-issue:7:${at(2000)}`, kind: 'intake', issue: 7 },
      { source_event_id: 'gh-comment:IC_1', kind: 'owner_comment', issue: 7 },
      { source_event_id: 'gh-check:unit:success', kind: 'ci', issue: 7 },
    ]);
    assert.equal(sessionOf(inbox.events()[1]), 'issue:7');
  });
});

test('a fired timer produces a timer-kind wakeup: heartbeat kind, its issue, and a timer source_event_id', async () => {
  await withRoot((root) => {
    const timers = openTimers(root);
    timers.once({ id: 'wait:5:ci', at: at(1000), event: { kind: 'heartbeat', issue: 5, payload: { wait: 'ci' } } });
    assert.equal(timers.fire(T0 + 1000), 1);
    const inbox = openInbox(root);
    assert.deepEqual(summary(inbox), [{ source_event_id: `timer:wait:5:ci:${T0 + 1000}`, kind: 'heartbeat', issue: 5 }]);
    assert.equal(sessionOf(inbox.events()[0]), 'issue:5');
  });
});

test('the periodic patrol heartbeat is a timer event with no issue and a per-firing source_event_id', async () => {
  await withRoot((root) => {
    const timers = openTimers(root);
    ensurePatrolTimer(timers, T0, 1000);
    assert.equal(timers.fire(T0), 1);
    assert.equal(timers.fire(T0 + 1000), 1);
    const inbox = openInbox(root);
    assert.deepEqual(summary(inbox), [
      { source_event_id: `timer:${PATROL_TIMER}:${T0}`, kind: 'heartbeat', issue: null },
      { source_event_id: `timer:${PATROL_TIMER}:${T0 + 1000}`, kind: 'heartbeat', issue: null },
    ]);
    assert.equal(inbox.events()[0].payload.job, 'patrol');
  });
});

test('a signed webhook delivery becomes a webhook event with no issue, keyed by its delivery id', async () => {
  await withRoot(async (root) => {
    const secret = 'fixture-secret';
    const body = Buffer.from(JSON.stringify({ action: 'opened' }));
    const handler = createHandler({ sources: { github: { secret, eventTypes: ['issues'] } }, inbox: openInbox(root) });
    // A loopback server bound by this test only; the default host never starts one.
    const server = createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/webhook/github`, {
        method: 'POST',
        body,
        headers: {
          'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
          'x-github-event': 'issues',
          'x-github-delivery': 'delivery-1',
        },
      });
      assert.equal(res.status, 202);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    const inbox = openInbox(root);
    assert.deepEqual(summary(inbox), [{ source_event_id: 'delivery-1', kind: 'webhook', issue: null }]);
    assert.equal(inbox.events()[0].payload.event_type, 'issues');
  });
});

test('the default host does not import or start the webhook listener', () => {
  for (const file of ['../../runtime/rtd.mjs', '../../runtime/lib/daemon-loop.mjs']) {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(src, /webhook-listener/, `${file} must not reference the webhook listener`);
  }
});
