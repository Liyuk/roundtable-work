import test from 'node:test';
import assert from 'node:assert/strict';
import { computeC } from '../scripts/rt-bench/metrics-cost.mjs';

// C1-C3 from docs/autonomy-benchmark.md section 11; expected levels come from their level tables.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-17T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ago = (h) => iso(NOW - h * HOUR);
const agoDays = (d) => iso(NOW - d * DAY);
const base = { now: NOW, productionStart: NOW - 30 * DAY };
const run = (id, sources) => computeC({ ...base, sources }).find((r) => r.id === id);
const pick = ({ value, level, measurable }) => ({ value, level, measurable });

const pr = (number, { mergedAt, closes = [], title = `PR ${number}`, revertOf } = {}) => ({ number, title, mergedAt, closes, revertOf });
const gh = (prs) => ({ asOf: NOW - MIN, prs });
const usage = (events, asOf = NOW - MIN) => ({ asOf, events });
const queue = (events, asOf = NOW - MIN) => ({ asOf, events });
// A usage row: tokens split in/out, optional cost.
const row = (issue, at, inTok, outTok, cost) => ({ at, issue, role: 'developer', model: 'm', inTok, outTok, rc: 0, parseOk: true, ...(cost === undefined ? {} : { cost }) });
// Issues 101 and 102 each closed by a merged PR 1 h ago.
const two = [pr(201, { closes: [101], mergedAt: ago(1) }), pr(202, { closes: [102], mergedAt: ago(1) })];
const twoRows = [row(101, ago(2), 1000, 500, 0.25), row(101, ago(1.5), 1000, 500, 0.25), row(102, ago(1), 2000, 1000, 1)];

test('computeC returns C1..C3 with the result fields, all not measurable with no sources', () => {
  const res = computeC({ ...base, sources: {} });
  assert.deepEqual(res.map((r) => r.id), ['C1', 'C2', 'C3']);
  for (const r of res) {
    assert.ok('value' in r && 'level' in r && 'window' in r && 'measurable' in r && 'source' in r && Array.isArray(r.evidence), r.id);
  }
  assert.ok(res.every((r) => r.measurable === false && r.level === 0 && r.value === null));
});

test('C1 tokens per completed issue: 6000 tokens over 2 completed issues is 3000, level capped at 4 below 20 issues', () => {
  // Issue 999 is not completed. A merged revert PR closing 103 does not complete it, so its tokens are not attributed.
  const rows = [...twoRows, row(999, ago(1), 1e6, 1e6, 1), row(103, ago(1), 7, 7, 1)];
  const prs = [...two, pr(203, { closes: [103], title: 'Revert "PR 150"', revertOf: 150, mergedAt: ago(0.5) })];
  const r = run('C1', { github: gh(prs), usage: usage(rows) });
  assert.deepEqual([r.value, r.level, r.measurable], [3000, 4, true]);
  assert.deepEqual(r.evidence, [{ issue: 101 }, { issue: 102 }]);
});

test('C1 cohort of 20 completed issues is uncapped: 3000 tokens each is level 5', () => {
  const prs = Array.from({ length: 20 }, (_, k) => pr(300 + k, { closes: [400 + k], mergedAt: ago(1) }));
  const rows = Array.from({ length: 20 }, (_, k) => row(400 + k, ago(1), 1000, 2000));
  assert.deepEqual(pick(run('C1', { github: gh(prs), usage: usage(rows) })), { value: 3000, level: 5, measurable: true });
});

test('C1 not measurable: unreliable row (parseOk not true), missing usage for a completed issue, empty cohort, missing or stale source', () => {
  const unreliable = [...twoRows, { ...row(102, ago(1), 2000, 1000), parseOk: false }];
  assert.deepEqual(pick(run('C1', { github: gh(two), usage: usage(unreliable) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C1', { github: gh(two), usage: usage(twoRows.slice(0, 2)) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C1', { github: gh([]), usage: usage(twoRows) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C1', { github: gh(two) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C1', { usage: usage(twoRows) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C1', { github: gh(two), usage: usage(twoRows, NOW - 25 * HOUR) })), { value: null, level: 0, measurable: false });
});

test('C2 cost per completed issue: cost 1.5 over 2 completed issues is 0.75, level 3', () => {
  const r = run('C2', { github: gh(two), usage: usage(twoRows) });
  assert.deepEqual([r.value, r.level, r.measurable], [0.75, 3, true]);
});

test('C2 not measurable: a counted row with no numeric cost, no cost data at all, or a stale source', () => {
  const noCost = [row(101, ago(2), 1000, 500, 0.25), row(102, ago(1), 2000, 1000)];
  assert.deepEqual(pick(run('C2', { github: gh(two), usage: usage(noCost) })), { value: null, level: 0, measurable: false });
  const noCostAtAll = twoRows.map(({ cost, ...r }) => r);
  assert.deepEqual(pick(run('C2', { github: gh(two), usage: usage(noCostAtAll) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C2', { github: gh(two), usage: usage(twoRows, NOW - 25 * HOUR) })), { value: null, level: 0, measurable: false });
});

// Queue snapshots at NOW-4h (idle), NOW-3h (claimable work, not idle), NOW-2h (idle), NOW-1h (idle, last: covers nothing after it).
const queueRows = [
  { at: ago(4), running: 0, claimable: 0 },
  { at: ago(3), running: 0, claimable: 2 },
  { at: ago(2), running: 0, claimable: 0 },
  { at: ago(1), running: 0, claimable: 0 },
];
test('C3 idle overhead: only usage in idle intervals counts (100 + 200 = 300 tokens, cost 3)', () => {
  const rows = [
    row(1, ago(3.5), 60, 40, 1), // idle interval [-4h, -3h)
    row(2, ago(2.5), 150, 50, 2), // busy: claimable work in [-3h, -2h), excluded
    row(3, ago(1.5), 120, 80, 2), // idle interval [-2h, -1h)
    row(4, ago(0.5), 900, 900, 9), // after the last snapshot, not covered, excluded
  ];
  const r = run('C3', { usage: usage(rows), queueSnapshot: queue(queueRows) });
  assert.deepEqual([r.value, r.level, r.measurable], [300, 5, true]);
  assert.deepEqual(r.evidence, [{ at: ago(3.5), issue: 1, tokens: 100 }, { at: ago(1.5), issue: 3, tokens: 200 }]);
});

test('C3 is level 0 when idle overhead exceeds 1e6 tokens', () => {
  const r = run('C3', { usage: usage([row(1, ago(3.5), 600000, 500000, 1)]), queueSnapshot: queue(queueRows) });
  assert.deepEqual([r.value, r.level, r.measurable], [1100000, 0, true]);
});

test('C3 not measurable: no queue source, no usage source, stale queue, usage not covered by any snapshot, or idle row without cost', () => {
  const rows = [row(1, ago(3.5), 60, 40, 1)];
  assert.deepEqual(pick(run('C3', { usage: usage(rows) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C3', { queueSnapshot: queue(queueRows) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C3', { usage: usage(rows), queueSnapshot: queue(queueRows, NOW - 25 * HOUR) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C3', { usage: usage([row(1, ago(0.5), 1, 1, 1)]), queueSnapshot: queue(queueRows) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('C3', { usage: usage([row(1, ago(3.5), 60, 40)]), queueSnapshot: queue(queueRows) })), { value: null, level: 0, measurable: false });
});
