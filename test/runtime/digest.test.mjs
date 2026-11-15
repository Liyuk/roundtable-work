import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDigest, anomalies, enqueueDigest, enqueueAnomalies, ensureDigestTimer, deadLetterCount, DIGEST_TIMER } from '../../runtime/lib/digest.mjs';
import { selfMetrics } from '../../runtime/lib/self-metrics.mjs';
import { scanHygiene } from '../../runtime/lib/hygiene.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { createGitHubOutboxProvider } from '../../runtime/lib/outbox-github.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T16:00:00Z');
const THRESHOLDS = { mtbiHoursMin: 24, firstPassRateMin: 0.8, ownerPullInsPerWeekMax: 3 };

const quiet = () => selfMetrics({ entries: [], freezes: [], now: NOW, windowDays: 7 });
const windowOf = (metrics) => metrics.window;

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'digest-test-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// A denylist pinned outside the repository, as the hygiene scanner requires.
async function withDenylist(fn) {
  await withRoot(async (root) => {
    const outside = join(root, 'external');
    const repository = join(root, 'repository');
    await mkdir(outside);
    await mkdir(repository);
    const bytes = Buffer.from(JSON.stringify(['distinctive-node']));
    const denylistPath = join(outside, 'names.json');
    await writeFile(denylistPath, bytes);
    await fn({ repoRoot: repository, denylistPath, expectedSha256: createHash('sha256').update(bytes).digest('hex') });
  });
}

const fakeWriter = () => {
  const comments = [];
  return {
    comments,
    listComments: async (issue) => comments.filter((c) => c.issue === issue).map((c) => ({ body: c.body })),
    createComment: async (issue, body) => { comments.push({ issue, body }); },
  };
};

test('a digest renders at most 30 lines from the fixed template and passes the hygiene scan', async () => {
  await withDenylist(async (hygiene) => {
    const metrics = quiet();
    const entries = [
      { at: '2026-11-14T10:00:00Z', source: 'self', category: 'backlog', ref: '#430', reason: 'Filed self-review finding' },
      { at: '2026-11-14T11:00:00Z', source: 'owner', category: 'owner-only', ref: 'rt:none', reason: 'Owner rebooted the host' },
    ];
    const merged = [{ number: 401, mergedAt: '2026-11-14T09:00:00Z' }];
    const actions = [{ id: 'act:decision:429:abc', kind: 'decision', issue: 429, state: 'executed_pending_confirmation', at: '2026-11-14T08:00:00Z' }];
    const text = buildDigest({ window: windowOf(metrics), metrics, entries, merged, actions, stage: 'S0', thresholds: THRESHOLDS, deadLetters: 0 });
    assert.ok(text.split('\n').length <= 30);
    assert.match(text, /^Roundtable digest 2026-11-08T16:00:00\.000Z to 2026-11-15T16:00:00\.000Z$/m);
    assert.match(text, /^Stage: S0$/m);
    assert.match(text, /^- PR #401 merged at 2026-11-14T09:00:00Z$/m);
    assert.match(text, /^- act:decision:429:abc on #429 \(rollback: \/rt rollback act:decision:429:abc\)$/m);
    assert.match(text, /^- #430$/m);
    assert.match(text, /^Counted interventions: 0$/m);
    assert.match(text, /^MTBI: 168\.0 h \(lower bound\)$/m);
    assert.match(text, /^Owner-only actions: 1$/m);
    assert.deepEqual(await scanHygiene({ entries: [{ value: text }], ...hygiene }), []);
  });
});

test('the digest caps its output at 30 lines', () => {
  const metrics = quiet();
  const merged = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, mergedAt: '2026-11-14T09:00:00Z' }));
  const text = buildDigest({ window: windowOf(metrics), metrics, entries: [], merged, actions: [], stage: 'S0', thresholds: THRESHOLDS, deadLetters: 0 });
  assert.equal(text.split('\n').length, 30);
});

test('a window with no merge, no default decision and no anomaly gives null', () => {
  const metrics = quiet();
  const text = buildDigest({ window: windowOf(metrics), metrics, entries: [], merged: [], actions: [], stage: 'S0', thresholds: THRESHOLDS, deadLetters: 0 });
  assert.equal(text, null);
  assert.deepEqual(anomalies({ entries: [], metrics, thresholds: THRESHOLDS, deadLetters: 0 }), []);
});

test('anomaly rules: restart-exhausted, intervention, threshold breach and dead-letter', () => {
  const at = new Date(NOW - DAY).toISOString();
  const restart = [{ at, source: 'self', category: 'liveness', ref: 'rt:watchdog', reason: 'restart-exhausted' }];
  assert.deepEqual(anomalies({ entries: restart, metrics: quiet(), thresholds: THRESHOLDS, deadLetters: 0 }), ['restart-exhausted']);

  const owner = [{ at, source: 'owner', category: 'merge', ref: '#401', reason: 'Owner merged by hand' }];
  const counted = selfMetrics({ entries: owner, freezes: [], now: NOW, windowDays: 7 });
  assert.deepEqual(anomalies({ entries: owner, metrics: counted, thresholds: THRESHOLDS, deadLetters: 0 }), ['intervention']);

  assert.deepEqual(anomalies({ entries: [], metrics: quiet(), thresholds: THRESHOLDS, deadLetters: 2 }), ['dead-letter']);
});

test('a threshold breach on owner pull-ins per week is detected', () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({ at: new Date(NOW - (i + 1) * DAY / 2).toISOString(), source: 'owner', category: 'decision', ref: '#1', reason: 'Owner decided' }));
  const metrics = selfMetrics({ entries, freezes: [], now: NOW, windowDays: 7 });
  assert.equal(metrics.pullIns.owner.total, 4);
  assert.ok(anomalies({ entries, metrics, thresholds: { ...THRESHOLDS, mtbiHoursMin: 0 }, deadLetters: 0 }).includes('threshold'));
});

test('the daily digest is a comment on the digest issue, or a digest notification without one, once per UTC date', async () => {
  await withDenylist(async (hygiene) => {
    await withRoot(async (root) => {
      const text = 'Roundtable digest';
      const outbox = openOutbox(root);
      assert.equal(await enqueueDigest({ outbox, now: NOW, issue: 500, text, hygiene }), true);
      assert.equal(await enqueueDigest({ outbox, now: NOW + 1000, issue: 500, text, hygiene }), false);
      assert.deepEqual(outbox.items(), [{ id: 'notice:digest:2026-11-15', kind: 'comment', issue: 500, payload: { body: text } }]);
    });
    await withRoot(async (root) => {
      const text = 'Roundtable digest';
      const bare = openOutbox(root);
      await enqueueDigest({ outbox: bare, now: NOW, issue: null, text, hygiene });
      assert.deepEqual(bare.items(), [{ id: 'notice:digest:2026-11-15', kind: 'notification', issue: null, payload: { subtype: 'digest', body: text } }]);
    });
  });
});

test('no digest is enqueued when there is nothing to report', async () => {
  await withDenylist(async (hygiene) => {
    await withRoot(async (root) => {
      const outbox = openOutbox(root);
      assert.equal(await enqueueDigest({ outbox, now: NOW, issue: 500, text: null, hygiene }), false);
      assert.deepEqual(outbox.items(), []);
    });
  });
});

test('a digest with a hygiene finding is not enqueued', async () => {
  await withDenylist(async (hygiene) => {
    await withRoot(async (root) => {
      const outbox = openOutbox(root);
      assert.equal(await enqueueDigest({ outbox, now: NOW, issue: 500, text: 'Stage: distinctive-node', hygiene }), false);
      assert.deepEqual(outbox.items(), []);
    });
  });
});

test('digest:daily is a recurring timer at digestHourUtc, registered once', async () => {
  await withRoot(async (root) => {
    const goals = { reporting: { digestHourUtc: 15 } };
    const timers = openTimers(root);
    ensureDigestTimer(timers, goals, NOW);
    ensureDigestTimer(timers, goals, NOW + DAY);
    const [timer] = timers.list();
    assert.equal(timer.id, DIGEST_TIMER);
    assert.equal(timer.at, Date.parse('2026-11-16T15:00:00Z'));
    assert.equal(timer.cadenceMs, DAY);
    assert.deepEqual(timer.event, { kind: 'heartbeat', issue: null, payload: { job: 'digest' } });
    assert.equal(timers.fire(timer.at), 1);
    assert.equal(timers.fire(timer.at), 0);
  });
});

test('ensureDigestTimer schedules today when the digest hour is still ahead', async () => {
  await withRoot(async (root) => {
    const timers = openTimers(root);
    ensureDigestTimer(timers, { reporting: { digestHourUtc: 18 } }, NOW);
    assert.equal(timers.list()[0].at, Date.parse('2026-11-15T18:00:00Z'));
  });
});

test('anomaly alerts are one notification per rule per UTC day', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    assert.deepEqual(enqueueAnomalies({ outbox, now: NOW, fired: ['restart-exhausted', 'dead-letter'] }), ['notice:anomaly:restart-exhausted:2026-11-15', 'notice:anomaly:dead-letter:2026-11-15']);
    assert.deepEqual(enqueueAnomalies({ outbox, now: NOW + 1000, fired: ['restart-exhausted'] }), []);
    assert.deepEqual(enqueueAnomalies({ outbox, now: NOW + DAY, fired: ['restart-exhausted'] }), ['notice:anomaly:restart-exhausted:2026-11-16']);
    assert.equal(outbox.items().length, 3);
    assert.equal(outbox.items()[0].kind, 'notification');
    assert.equal(outbox.items()[0].payload.subtype, 'stall-alert');
  });
});

test('deadLetterCount counts items that are neither pending nor delivered', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    outbox.enqueue({ id: 'a', kind: 'comment', issue: 1, payload: { body: 'x' } });
    outbox.enqueue({ id: 'b', kind: 'comment', issue: 1, payload: { body: 'y' } });
    outbox.markDelivered('a', { ok: true });
    outbox.markDead('b');
    assert.equal(deadLetterCount(outbox), 1);
  });
});

test('the GitHub provider posts a notification as a marked comment on its issue, or on the digest issue', async () => {
  const writer = fakeWriter();
  const provider = createGitHubOutboxProvider({ writer, digestIssue: 500 });
  await provider.deliver({ id: 'notice:digest:2026-11-15', kind: 'comment', issue: 500, payload: { body: 'digest body' } });
  await provider.deliver({ id: 'n1', kind: 'notification', issue: 429, payload: { subtype: 'stall-alert', of: 'x' } });
  await provider.deliver({ id: 'n2', kind: 'notification', issue: null, payload: { subtype: 'digest', body: 'digest body' } });
  await provider.deliver({ id: 'n3', kind: 'notification', issue: 429, payload: { subtype: 'approval-request', of: 'act:1', action: 'merge' } });
  await provider.deliver({ id: 'n4', kind: 'notification', issue: 429, payload: { subtype: 'action-pending-confirmation', action: 'act:1' } });
  assert.deepEqual(writer.comments.map((c) => [c.issue, c.body.split('\n')[0]]), [
    [500, '<!-- rt:outbox notice:digest:2026-11-15 -->'],
    [429, '<!-- rt:outbox n1 -->'],
    [500, '<!-- rt:outbox n2 -->'],
    [429, '<!-- rt:outbox n3 -->'],
    [429, '<!-- rt:outbox n4 -->'],
  ]);
  assert.match(writer.comments[1].body, /Stall alert for x/);
  assert.match(writer.comments[3].body, /Approval requested for act:1: merge/);
  assert.match(writer.comments[4].body, /Action act:1 on issue #429 awaits confirmation/);
});

test('the GitHub provider posts a notification once per item id and rejects other subtypes', async () => {
  const writer = fakeWriter();
  const provider = createGitHubOutboxProvider({ writer, digestIssue: null });
  await provider.deliver({ id: 'n1', kind: 'notification', issue: 429, payload: { subtype: 'stall-alert', of: 'x' } });
  await provider.deliver({ id: 'n1', kind: 'notification', issue: 429, payload: { subtype: 'stall-alert', of: 'x' } });
  assert.equal(writer.comments.length, 1);
  await assert.rejects(provider.deliver({ id: 'n5', kind: 'notification', issue: 429, payload: { subtype: 'merge-notice', pr: 1, head: 'a' } }), TypeError);
});
