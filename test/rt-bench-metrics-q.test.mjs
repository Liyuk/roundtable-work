import test from 'node:test';
import assert from 'node:assert/strict';
import { computeQ } from '../scripts/rt-bench/metrics-q.mjs';

// Q1-Q3 from docs/autonomy-benchmark.md section 10; expected levels come from their level tables.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-17T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ago = (h) => iso(NOW - h * HOUR);
const agoDays = (d) => iso(NOW - d * DAY);
const base = { now: NOW, productionStart: NOW - 30 * DAY };
const run = (id, sources) => computeQ({ ...base, sources }).find((r) => r.id === id);

const pr = (number, { mergedAt, closes = [], title = `PR ${number}`, revertOf } = {}) => ({ number, title, mergedAt, closes, revertOf });
const gh = (prs, issues = []) => ({ asOf: NOW - MIN, issues, prs });
const outcomes = (events) => ({ asOf: NOW - MIN, events });
// n merged PRs (numbers 100..) merged 1 h before NOW.
const cohort = (n, mergedAt = ago(1)) => Array.from({ length: n }, (_, k) => pr(100 + k, { mergedAt }));

test('computeQ returns Q1..Q3 with the result fields', () => {
  const res = computeQ({ ...base, sources: {} });
  assert.deepEqual(res.map((r) => r.id), ['Q1', 'Q2', 'Q3']);
  for (const r of res) {
    assert.ok('value' in r && 'level' in r && 'window' in r && 'measurable' in r && 'source' in r && Array.isArray(r.evidence), r.id);
  }
  assert.ok(res.every((r) => r.measurable === false && r.level === 0 && r.value === null));
});

test('Q1 rework/revert rate: 0 of 20 flagged is level 5, 2 of 20 (a rework and a revert) is 10% level 2, 10 of 20 is level 0', () => {
  // Reworks are on PRs 100..; the revert PR is not in the cohort and flags PR 101 through revertOf.
  const cases = [[0, 0, 5], [2, 10, 2], [10, 50, 0]];
  for (const [k, value, level] of cases) {
    const prs = cohort(20);
    const events = Array.from({ length: k }, (_, i) => ({ at: ago(0.5), pr: 100 + i, kind: 'rework' }));
    const r = run('Q1', { github: gh(prs), outcomes: outcomes(events) });
    assert.deepEqual([r.value, r.level, r.measurable], [value, level, true], `${k} reworked`);
  }
  const revert = [...cohort(20), pr(300, { title: 'Revert "PR 101"', revertOf: 101, mergedAt: ago(0.5) })];
  const r = run('Q1', { github: gh(revert), outcomes: outcomes([{ at: ago(0.5), pr: 102, kind: 'rework' }]) });
  assert.deepEqual([r.value, r.level], [10, 2]);
  assert.equal(r.evidence.length, 2);
});

test('Q1 cohort below 20 is capped at level 4', () => {
  const r = run('Q1', { github: gh(cohort(10)), outcomes: outcomes([]) });
  assert.deepEqual([r.value, r.level, r.measurable], [0, 4, true]);
});

test('Q1 empty cohort, missing or stale sources are not measurable with value null', () => {
  assert.deepEqual(pick(run('Q1', { github: gh([]), outcomes: outcomes([]) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('Q1', { github: gh(cohort(20)) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('Q1', { github: { prs: cohort(20) }, outcomes: outcomes([]) })), { value: null, level: 0, measurable: false });
  const stale = { asOf: NOW - 25 * HOUR, events: [] };
  assert.deepEqual(pick(run('Q1', { github: gh(cohort(20)), outcomes: stale })), { value: null, level: 0, measurable: false });
});

test('Q2 14-day survival: 20 of 20 is level 5, 18 of 20 is 90% level 3, 8 of 20 is 40% level 0', () => {
  // PRs merged 14 d 1 h ago: their 14-day point (1 h ago) is in W. Reworks are 1 d after merge.
  const merged = iso(NOW - 14 * DAY - HOUR);
  const cases = [[0, 100, 5], [2, 90, 3], [12, 40, 0]];
  for (const [k, value, level] of cases) {
    const events = Array.from({ length: k }, (_, i) => ({ at: iso(NOW - 13 * DAY - HOUR), pr: 100 + i, kind: 'revert' }));
    const r = run('Q2', { github: gh(cohort(20, merged)), outcomes: outcomes(events) });
    assert.deepEqual([r.value, r.level, r.measurable], [value, level, true], `${k} lost`);
  }
});

test('Q2 counts only outcomes up to the 14-day point', () => {
  // PR merged 20 d ago: 14-day point 6 d ago. A rework 17 d after merge is too late; one 1 d after merge counts.
  const late = [{ at: agoDays(3), pr: 1, kind: 'rework' }];
  const early = [{ at: agoDays(19), pr: 1, kind: 'rework' }];
  const prs = [pr(1, { mergedAt: agoDays(20) })];
  assert.equal(run('Q2', { github: gh(prs), outcomes: outcomes(late) }).value, 100);
  assert.equal(run('Q2', { github: gh(prs), outcomes: outcomes(early) }).value, 0);
});

test('Q2 cohort below 20 is capped at level 4; PRs whose 14-day point is outside W are not in the cohort', () => {
  const r = run('Q2', { github: gh(cohort(10, agoDays(14.1))), outcomes: outcomes([]) });
  assert.deepEqual([r.value, r.level], [100, 4]);
  assert.equal(run('Q2', { github: gh([pr(1, { mergedAt: agoDays(30) })]), outcomes: outcomes([]) }).value, null);
});

test('Q2 empty cohort, missing or stale sources are not measurable with value null', () => {
  assert.deepEqual(pick(run('Q2', { github: gh([]), outcomes: outcomes([]) })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('Q2', { github: gh(cohort(20, agoDays(14.1))) })), { value: null, level: 0, measurable: false });
  const stale = { asOf: NOW - 25 * HOUR, events: [] };
  assert.deepEqual(pick(run('Q2', { github: gh(cohort(20, agoDays(14.1))), outcomes: stale })), { value: null, level: 0, measurable: false });
});

// Q3 issues: issue 100+k closed by PR 200+k merged 7 d + (k+1) h ago, so its 7-day point is (k+1) h ago.
const bench = (cur, exp, id = 'U1') => `Bench: ${id} ${cur} -> ${exp} (level 1 -> 2) within 7 d`;
function q3Sources(bodies, observed) {
  const issues = bodies.map((body, k) => ({ number: 101 + k, body }));
  const prs = bodies.map((_, k) => pr(201 + k, { closes: [101 + k], mergedAt: iso(NOW - 7 * DAY - (k + 1) * HOUR) }));
  const events = observed.map((v, k) => ({ at: iso(NOW - (k + 1) * HOUR + MIN), ids: { U1: { value: v } } }));
  return { github: gh(prs, issues), benchSnapshots: { asOf: NOW - MIN, events } };
}

test('Q3 per-issue benchmark delta: increase 40% -> 60%, 4 of 5 achieved is 80% level 4', () => {
  const r = run('Q3', q3Sources(Array(5).fill(bench('40%', '60%')), [60, 70, 65, 50, 80]));
  assert.deepEqual([r.value, r.level, r.measurable], [80, 4, true]);
  assert.deepEqual(r.evidence[3], { issue: 104, id: 'U1', current: 40, expected: 60, observed: 50, delta: 10, achieved: false });
});

test('Q3 decrease 10% -> <5%, 3 of 5 achieved is 60% level 3', () => {
  const r = run('Q3', q3Sources(Array(5).fill(bench('10%', '<5%')), [5, 4, 6, 5, 7]));
  assert.deepEqual([r.value, r.level], [60, 3]);
});

test('Q3 non-numeric current is not evaluated; a single evaluation is capped at level 4', () => {
  const bodies = [bench('n/m', 5), bench('n/m', 5), bench('n/m', 5), bench('n/m', 5), bench(40, 60)];
  const r = run('Q3', q3Sources(bodies, [0, 0, 0, 0, 70]));
  assert.deepEqual([r.value, r.level, r.evidence.length], [100, 4, 1]);
});

test('Q3 observed value is the first snapshot at or after the evaluation point', () => {
  const sources = {
    github: gh([pr(201, { closes: [101], mergedAt: iso(NOW - 7 * DAY - 2 * HOUR) })], [{ number: 101, body: bench(40, 60) }]),
    benchSnapshots: {
      asOf: NOW - MIN,
      events: [
        { at: ago(3), ids: { U1: { value: 1 } } },
        { at: iso(NOW - 2 * HOUR + MIN), ids: { U1: { value: 70 } } },
        { at: ago(1), ids: { U1: { value: 10 } } },
      ],
    },
  };
  assert.equal(run('Q3', sources).evidence[0].observed, 70);
});

test('Q3 unevaluated points: a point after NOW, no Bench line, or no value for the ID are not counted', () => {
  const future = { github: gh([pr(201, { closes: [101], mergedAt: ago(1) })], [{ number: 101, body: bench(40, 60) }]), benchSnapshots: { asOf: NOW - MIN, events: [] } };
  assert.deepEqual(pick(run('Q3', future)), { value: null, level: 0, measurable: false });
  const noLine = q3Sources(['no bench line'], [70]);
  assert.deepEqual(pick(run('Q3', noLine)), { value: null, level: 0, measurable: false });
  const noId = q3Sources(Array(5).fill(bench(40, 60, 'L1')), [70, 70, 70, 70, 70]);
  assert.deepEqual(pick(run('Q3', noId)), { value: null, level: 0, measurable: false });
});

test('Q3 missing or stale sources are not measurable with value null', () => {
  const sources = q3Sources(Array(5).fill(bench(40, 60)), [60, 70, 65, 50, 80]);
  assert.deepEqual(pick(run('Q3', { github: sources.github })), { value: null, level: 0, measurable: false });
  assert.deepEqual(pick(run('Q3', { benchSnapshots: sources.benchSnapshots })), { value: null, level: 0, measurable: false });
  const stale = { ...sources.benchSnapshots, asOf: NOW - 25 * HOUR };
  assert.deepEqual(pick(run('Q3', { ...sources, benchSnapshots: stale })), { value: null, level: 0, measurable: false });
});

const pick = ({ value, level, measurable }) => ({ value, level, measurable });
