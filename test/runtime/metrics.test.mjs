import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeMetrics, runMetrics } from '../../runtime/lib/metrics.mjs';

// One fixture day, 2026-11-15 UTC. Times are epoch ms built from UTC clock readings.
const T = (day, h, m = 0) => Date.UTC(2026, 10, day, h, m);
const SINCE = T(15, 0);
const UNTIL = T(16, 0);
const DAY = '2026-11-15';

const issues = [
  { id: 101, status: 'done', attempts: { developer: 0, wakes: 1 }, gateRecord: { passed: ['gate0', 'gate1', 'gate2'] },
    ledger: [{ id: 'claim', type: 'claimed', at: T(15, 8) }, { id: 'merged:1', type: 'merged', at: T(15, 10) }],
    lastEvent: { type: 'ready_recorded', at: T(15, 10) } },
  { id: 102, status: 'queued', attempts: { developer: 1, wakes: 3 }, gateRecord: { passed: ['gate0'] },
    ledger: [{ id: 'claim', type: 'claimed', at: T(15, 8, 30) }],
    lastEvent: { type: 'terminal_closed', at: T(15, 11) } },
  { id: 104, status: 'done', attempts: { developer: 0, wakes: 2 }, gateRecord: { passed: ['gate1'] },
    ledger: [{ id: 'merged:2', type: 'merged', at: T(15, 15) }],
    lastEvent: { type: 'merged', at: T(15, 15) } },
];

const usage = [
  { issue: 101, role: 'developer', model: 'm', inputTokens: 100, outputTokens: 20, usageKnown: true, wallMs: 60000, at: T(15, 8, 30) },
  { issue: 102, role: 'developer', model: 'm', inputTokens: 200, outputTokens: 50, usageKnown: true, wallMs: 120000, at: T(15, 9) },
  { issue: 102, role: 'fixer', model: 'm', inputTokens: null, outputTokens: null, usageKnown: false, wallMs: 30000, at: T(15, 9, 30) },
];

const freezes = [
  { start: T(15, 3), end: T(15, 3, 20), class: 'host-freeze' },
  { start: T(14, 23), end: T(15, 0, 30), class: 'host-freeze' },
  { start: T(15, 13), end: T(15, 13, 5), class: 'scheduler-stall' },
];

const inbox = [
  { kind: 'owner_comment', issue: 101, receivedAt: T(15, 9, 45), payload: { author: 'maintainer', decision: 'approve' } },
  { kind: 'owner_comment', issue: 101, receivedAt: T(15, 7), payload: { author: 'maintainer' } },
  { kind: 'owner_comment', issue: 101, receivedAt: T(15, 12), payload: { author: 'maintainer' } },
  { kind: 'owner_comment', issue: 102, receivedAt: T(15, 13), payload: { author: 'Maintainer', decision: 'reject' } },
  { kind: 'owner_comment', issue: 102, receivedAt: T(15, 12, 30), payload: { author: 'someone-else' } },
  { kind: 'owner_comment', issue: 102, receivedAt: T(15, 8), payload: { author: 'maintainer' } },
  { kind: 'ci', issue: 101, receivedAt: T(15, 9), payload: { suite: 'ci', conclusion: 'success' } },
];

// Ask 'a' is supervisor-held; 'b' was routed to the owner, then resolved by the supervisor (counts once, as supervisor-held);
// 'c' stayed with the owner; 'old' is before the window.
const asks = [
  { issue: 101, key: 'a', route: 'supervisor', at: T(15, 9) },
  { issue: 101, key: 'b', route: 'owner', at: T(15, 10) },
  { issue: 101, key: 'b', route: 'supervisor', at: T(15, 11) },
  { issue: 102, key: 'c', route: 'owner', at: T(15, 12) },
  { issue: 103, key: 'old', route: 'owner', at: T(14, 23) },
];

const fixture = { since: SINCE, until: UNTIL, owner: 'maintainer', inbox, issues, usage, freezes, asks };

test('one fixture day pins every metric, per day and in total', () => {
  const report = computeMetrics(fixture);
  const expected = {
    ownerPullBacks: 3,
    firstDispatchSuccess: { succeeded: 1, dispatched: 2, rate: 0.5 },
    wakesPerIssue: { median: 2, max: 3, issues: 3 },
    fixRounds: 1,
    gateFailVerdicts: { na: 'gate verdicts are not persisted as history' },
    quotaIdle: { na: 'quota waits are not persisted' },
    frozen: { hostFreezeMs: 3000000, schedulerStallMs: 300000, entries: 3 },
    concurrency: 210000 / 86400000,
    tokensPerMergedPr: { mergedPrs: 2, usageKnownShare: 1, issuesWithoutUsage: 1, perPr: 60 },
    asks: { supervisorHeld: 2, ownerInterruptions: 1 },
  };
  assert.deepEqual(report.total, expected);
  assert.deepEqual(Object.keys(report.days), [DAY]);
  assert.deepEqual(report.days[DAY], { ...expected, wakesPerIssue: { na: 'wake counter is not timestamped; total only' } });
});

test('missing sources degrade to n/a with a reason, never 0', () => {
  const report = computeMetrics({ since: SINCE, until: UNTIL });
  for (const value of Object.values(report.total)) assert.equal(typeof value.na, 'string');
  assert.deepEqual(report.total.ownerPullBacks, { na: 'owner login not given (--owner)' });
  assert.deepEqual(report.total.frozen, { na: 'freeze ledger not present' });
  assert.deepEqual(report.total.tokensPerMergedPr, { na: 'issue states not present' });
  assert.deepEqual(report.total.asks, { na: 'ask ledger not present' });
  const noUsage = computeMetrics({ ...fixture, usage: null });
  assert.deepEqual(noUsage.total.concurrency, { na: 'usage ledger not present' });
  assert.deepEqual(noUsage.total.fixRounds, { na: 'usage ledger not present' });
});

test('loader reads the work root; invalid --since is rejected', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'rt-metrics-'));
  try {
    await mkdir(join(workRoot, 'state'));
    await writeFile(join(workRoot, 'state', 'freeze-ledger.jsonl'), `${JSON.stringify(freezes[2])}\nnot json\n`);
    await writeFile(join(workRoot, 'state', 'ask-ledger.jsonl'), `${asks.map((a) => JSON.stringify(a)).join('\n')}\nnot json\n`);
    const json = JSON.parse(await runMetrics({ argv: ['--since', '2026-11-15T00:00:00Z', '--json', '--work-root', workRoot], now: () => UNTIL }));
    assert.deepEqual(json.total.frozen, { hostFreezeMs: 0, schedulerStallMs: 300000, entries: 1 });
    assert.deepEqual(json.total.ownerPullBacks, { na: 'owner login not given (--owner)' });
    assert.deepEqual(json.total.asks, { supervisorHeld: 2, ownerInterruptions: 1 });
    await assert.rejects(runMetrics({ argv: ['--since', 'yesterday'], now: () => UNTIL }), /--since/);
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
});
