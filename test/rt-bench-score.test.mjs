import test from 'node:test';
import assert from 'node:assert/strict';
import { dimensionScore, measure, score } from '../scripts/rt-bench/score.mjs';

// Scoring rules from docs/autonomy-benchmark.md section 7 and the "not measurable" rule in section 2.

const NOW = Date.parse('2026-11-17T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const FRESH = { asOf: NOW - 60_000 };

// Baseline sub-metric levels from the section 7 table: profile U0 L1 I1 D2, overall 0.
const BASELINE = { U: [1, 1, 0, 1, 2, 0], L: [2, 1, 1, 0, 2], I: [0, 0, 0, 0, 5], D: [1, 3, 1, 4, 3] };
const baselineResults = Object.entries(BASELINE).flatMap(([dim, levels]) =>
  levels.map((level, i) => ({ id: `${dim}${i + 1}`, level, source: FRESH })),
);

test('baseline fixture reproduces profile U0 L1 I1 D2, overall 0', () => {
  assert.deepEqual(score(baselineResults, NOW), { U: 0, L: 1, I: 1, D: 2, overall: 0 });
});

test('missing source is level 0 and not measurable', () => {
  assert.deepEqual(measure({ id: 'U3', level: 4 }, NOW), { id: 'U3', level: 0, measurable: false, source: undefined });
});

test('source older than 24 h is level 0 and not measurable', () => {
  const stale = { asOf: NOW - DAY - 1 };
  assert.deepEqual(measure({ id: 'U3', level: 4, source: stale }, NOW), { id: 'U3', level: 0, measurable: false, source: stale });
});

test('source exactly 24 h old is still measurable and keeps its level', () => {
  const edge = { asOf: NOW - DAY };
  assert.deepEqual(measure({ id: 'U3', level: 4, source: edge }, NOW), { id: 'U3', level: 4, measurable: true, source: edge });
});

test('floor of the mean limits the dimension score', () => {
  assert.equal(dimensionScore([2, 2, 2, 3]), 2); // mean 2.25 -> 2; min+1 = 3
  assert.equal(dimensionScore([3, 3, 3, 3]), 3); // mean 3 exactly
});

test('weakest sub-metric plus one limits the dimension score', () => {
  assert.equal(dimensionScore([1, 4, 4, 4]), 2); // mean 3.25 -> 3; min+1 = 2 wins
  assert.equal(dimensionScore([0, 5, 5, 5]), 1); // mean 3.75 -> 3; min+1 = 1 wins
});

test('level 5 requires every sub-metric at 5', () => {
  assert.equal(dimensionScore([5, 5, 5, 5]), 5);
  assert.equal(dimensionScore([4, 5, 5, 5]), 4); // mean 4.75 -> 4
  assert.equal(dimensionScore([5, 5, 5, 5, 4]), 4); // mean 4.8 -> 4, min+1 = 5
});

test('overall is the minimum of the four dimension scores', () => {
  const all = (level) => ['U', 'L', 'I', 'D'].flatMap((d) => [1, 2, 3].map((i) => ({ id: `${d}${i}`, level, source: FRESH })));
  assert.deepEqual(score(all(4), NOW), { U: 4, L: 4, I: 4, D: 4, overall: 4 });
  const mixed = all(4).map((r) => (r.id === 'I2' ? { ...r, level: 1 } : r));
  assert.deepEqual(score(mixed, NOW), { U: 4, L: 4, I: 2, D: 4, overall: 2 });
});

test('a stale sub-metric drags its dimension to zero through level 0', () => {
  const stale = baselineResults.map((r) => (r.id === 'D5' ? { ...r, source: { asOf: NOW - DAY - 1 } } : r));
  assert.equal(score(stale, NOW).D, 1); // D levels 1,3,1,4,0: mean 1.8 -> 1; min+1 = 1
});
