import test from 'node:test';
import assert from 'node:assert/strict';
import { computeU } from '../scripts/rt-bench/metrics-u.mjs';

// U1-U6 from docs/autonomy-benchmark.md section 3; expected levels come from its level tables.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-17T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const fresh = (events) => ({ asOf: NOW - MIN, events });
// Production start 30 d back, so the window is the full 7 d (168 h).
const base = { now: NOW, productionStart: NOW - 30 * DAY };
const EMPTY = { interventions: fresh([]), schedStarts: fresh([]), schedGaps: fresh([]), stages: fresh([]), self: fresh([]) };
const run = (id, sources) => computeU({ ...base, sources: { ...EMPTY, ...sources } }).find((r) => r.id === id);

// n events, one every `step` ms, the newest at `last`.
const series = (n, step, last = NOW) => Array.from({ length: n }, (_, k) => ({ at: iso(last - k * step) }));

test('computeU returns U1..U6 in order with the result fields', () => {
  const res = computeU({ ...base, sources: EMPTY });
  assert.deepEqual(res.map((r) => r.id), ['U1', 'U2', 'U3', 'U4', 'U5', 'U6']);
  for (const r of res) {
    assert.ok('value' in r && 'level' in r && 'window' in r && 'measurable' in r && Array.isArray(r.evidence));
  }
  assert.equal(run('U3', { schedStarts: fresh([]) }).source.asOf, NOW - MIN);
});

test('U1 MTBI: 2.0 h is level 1, 1.9 h is level 0', () => {
  assert.equal(run('U1', { interventions: fresh(series(84, 2 * HOUR)) }).level, 1); // 168 / 84 = 2.0
  assert.equal(run('U1', { interventions: fresh(series(89, HOUR)) }).level, 0); // 168 / 89 = 1.89
});

test('U1 clusters events within 30 min into one episode', () => {
  assert.equal(run('U1', { interventions: fresh(series(2, 10 * MIN)) }).value, 168); // one episode
  assert.equal(run('U1', { interventions: fresh(series(2, 40 * MIN)) }).value, 84); // two episodes
});

test('U2 longest streak: 6.0 h is level 1, 5.9 h is level 0', () => {
  const six = run('U2', { interventions: fresh(series(28, 6 * HOUR)) });
  assert.equal(six.value, 6);
  assert.equal(six.level, 1);
  assert.equal(run('U2', { interventions: fresh(series(29, 5.9 * HOUR)) }).level, 0);
});

test('U2 with no interventions is the whole window', () => {
  assert.equal(run('U2', {}).value, 168);
});

test('U3 manual scheduler starts: 14 is level 1, 15 is level 0', () => {
  const cases = [[0, 5], [1, 4], [3, 3], [7, 2], [14, 1], [15, 0]];
  for (const [n, level] of cases) {
    const manual = series(n, HOUR).map((e) => ({ ...e, by: 'manual' }));
    const starts = [{ at: iso(NOW - MIN), by: 'unit' }, ...manual]; // unit starts are not counted
    const r = run('U3', { schedStarts: fresh(starts) });
    assert.deepEqual([r.value, r.level], [n, level]);
  }
});

// Gap k resumes at NOW - 4 h (k+1); the first `unrecovered` gaps get no human action, the rest get one 30 min after resume.
function gapSources(n, unrecovered) {
  const gaps = Array.from({ length: n }, (_, k) => {
    const resumed = NOW - (k + 1) * 4 * HOUR;
    return { at: iso(resumed - 5 * MIN), resumedAt: iso(resumed) };
  });
  const recovered = gaps.slice(unrecovered).map((g) => ({ at: iso(Date.parse(g.resumedAt) + 30 * MIN) }));
  return { schedGaps: fresh(gaps), interventions: fresh(recovered) };
}

test('U4 self-recovery: 18 of 29 unrecovered is 62 (doc example)', () => {
  const r = run('U4', gapSources(29, 18));
  assert.equal(Math.round(r.value), 62);
  assert.equal(r.level, 1);
});

test('U4 level boundaries', () => {
  const cases = [[5, 0, 0], [2, 1, 1], [20, 14, 2], [20, 17, 3], [20, 19, 4], [5, 5, 5], [4, 4, 4]]; // [gaps, unrecovered, level]
  for (const [n, unrecovered, level] of cases) {
    assert.equal(run('U4', gapSources(n, unrecovered)).level, level, `${unrecovered} of ${n}`);
  }
});

test('U4 with zero gaps in W is not measurable', () => {
  const r = run('U4', {});
  assert.deepEqual([r.measurable, r.level], [false, 0]);
});

test('U5 lost stages: 12 is level 1, 13 is level 0', () => {
  const cases = [[0, 5], [1, 4], [3, 3], [6, 2], [12, 1], [13, 0]];
  for (const [n, level] of cases) {
    const lost = Array.from({ length: n }, (_, k) => ({ at: iso(NOW - (k + 2) * HOUR), rc: k % 2 ? -15 : 124, finalState: 'lost' }));
    const stages = [{ at: iso(NOW - HOUR), rc: 0, finalState: 'done' }, ...lost]; // rc 0 is not counted
    const r = run('U5', { stages: fresh(stages) });
    assert.deepEqual([r.value, r.level], [n, level]);
  }
});

test('U6 fixture: self entries in 5 of 7 slices is value 5, level 3, measurable', () => {
  // Slice k is (NOW - 24(k+1) h, NOW - 24k h]; one entry per slice, 1 h before its end.
  const selfEv = [0, 1, 2, 4, 6].map((k) => ({ at: iso(NOW - (24 * k + 1) * HOUR), kind: 'self' }));
  const r = run('U6', { self: fresh(selfEv) });
  assert.deepEqual([r.value, r.level, r.measurable], [5, 3, true]);
});

test('U6 slice-count boundaries', () => {
  const cases = [[0, 0], [1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 4], [7, 5]];
  for (const [n, level] of cases) {
    const selfEv = Array.from({ length: n }, (_, k) => ({ at: iso(NOW - (24 * k + 1) * HOUR) }));
    assert.equal(run('U6', { self: fresh(selfEv) }).level, level, `${n} slices`);
  }
});

test('U6 without a self source is not measurable', () => {
  const r = computeU({ ...base, sources: {} }).find((x) => x.id === 'U6');
  assert.deepEqual([r.measurable, r.level], [false, 0]);
});

test('missing source, or asOf missing or older than 24 h, gives level 0 and not measurable', () => {
  for (const r of computeU({ ...base, sources: {} })) {
    assert.deepEqual([r.measurable, r.level], [false, 0], r.id);
  }
  const noAsOf = run('U1', { interventions: { events: series(84, 2 * HOUR) } });
  assert.deepEqual([noAsOf.measurable, noAsOf.level], [false, 0]);
  const stale = run('U5', { stages: { asOf: NOW - DAY - 1, events: [] } });
  assert.deepEqual([stale.measurable, stale.level], [false, 0]);
});

// Effective time (section 2): pauses and idle queue snapshots are removed from the windows.
test('idle queue time does not lengthen the U2 gap it sits in', () => {
  // Interventions at -160 h and -10 h; the gap between them is 150 h. Idle covers -150 h..-20 h (130 h), so it is 20 h.
  const ivs = fresh([{ at: iso(NOW - 160 * HOUR) }, { at: iso(NOW - 10 * HOUR) }]);
  const queue = fresh([{ at: iso(NOW - 150 * HOUR), running: 0, claimable: 0 }, { at: iso(NOW - 20 * HOUR), running: 1, claimable: 0 }]);
  assert.equal(run('U2', { interventions: ivs }).value, 150);
  assert.equal(run('U2', { interventions: ivs, queue }).value, 20);
});

test('environment pause is excluded from U1 and U2', () => {
  const pauses = { asOf: NOW - MIN, events: [{ start: iso(NOW - 24 * HOUR), end: iso(NOW) }] };
  assert.equal(run('U2', { pauses }).value, 144); // 168 h window minus 24 h pause
  assert.equal(run('U1', { pauses }).value, 144); // no episodes: the effective window
  // Episodes are not excluded: 144 effective h over the 84 episodes from the 2 h series.
  assert.equal(run('U1', { interventions: fresh(series(84, 2 * HOUR)), pauses }).value, 144 / 84);
});

test('an idle-only stretch is not success: U2 and U1 do not grow across it', () => {
  // Empty queue from -100 h to now: only the first 68 h of the window is effective.
  const queue = fresh([{ at: iso(NOW - 100 * HOUR), running: 0, claimable: 0 }]);
  assert.equal(run('U2', { queue }).value, 68); // 168 h window minus the 100 h idle tail
  assert.equal(run('U1', { queue }).value, 68);
});
