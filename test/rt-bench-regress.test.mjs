import test from 'node:test';
import assert from 'node:assert/strict';
import { benchRegressions } from '../runtime/lib/bench-regress.mjs';

// Seam: benchRegressions(rows) over the two latest bench.jsonl rows (oldest first). Expected lines are literals.
const row = (at, { U3 = [0, 5, true], U1 = [72, 5, true] } = {}, dims = { U: 5, L: 5, I: 5, D: 5, overall: 5 }) => ({
  at,
  ids: { U1: { value: U1[0], level: U1[1], measurable: U1[2] }, U3: { value: U3[0], level: U3[1], measurable: U3[2] } },
  dimensions: dims,
});
const prev = row('2026-11-14T00:00:00.000Z', { U3: [21, 5, true] });

test('a sub-metric level drop yields one bench:<ID> proposal, p2 when its dimension did not drop', () => {
  const latest = row('2026-11-15T00:00:00.000Z', { U3: [0, 2, true] }, { U: 5, L: 5, I: 5, D: 5, overall: 5 });
  const out = benchRegressions([prev, latest]);
  assert.deepEqual(out.map((r) => [r.fingerprint, r.priority]), [['bench:U3', 'p2']]);
  assert.equal(out[0].line, 'Bench: U3 0 -> 21 (level 2 -> 5) within 7 d');
});

test('a sub-metric regression whose dimension dropped is p1', () => {
  const latest = row('2026-11-15T00:00:00.000Z', { U3: [0, 2, true] }, { U: 4, L: 5, I: 5, D: 5, overall: 4 });
  const out = benchRegressions([prev, latest]);
  assert.deepEqual(out.map((r) => [r.fingerprint, r.priority]), [['bench:U3', 'p1']]);
});

test('measurable true -> false is a regression at level 0', () => {
  const latest = row('2026-11-15T00:00:00.000Z', { U3: [null, 0, false] });
  const out = benchRegressions([prev, latest]);
  assert.deepEqual(out.map((r) => [r.fingerprint, r.line]), [['bench:U3', 'Bench: U3 null -> 21 (level 0 -> 5) within 7 d']]);
});

test('measurable true -> false is a regression even when the level was already 0', () => {
  const was = row('2026-11-14T00:00:00.000Z', { U3: [0, 0, true] });
  const out = benchRegressions([was, row('2026-11-15T00:00:00.000Z', { U3: [null, 0, false] })]);
  assert.deepEqual(out.map((r) => r.fingerprint), ['bench:U3']);
});

test('a dimension drop with no sub-metric regression in it yields bench:<dim> p1 and bench:overall p1, with the dimension score', () => {
  const latest = row('2026-11-15T00:00:00.000Z', {}, { U: 3, L: 5, I: 5, D: 5, overall: 3 });
  const out = benchRegressions([prev, latest]);
  assert.deepEqual(out.map((r) => [r.fingerprint, r.priority, r.line]), [
    ['bench:U', 'p1', 'Bench: U 3 -> 5 (level 3 -> 5) within 7 d'],
    ['bench:overall', 'p1', 'Bench: overall 3 -> 5 (level 3 -> 5) within 7 d'],
  ]);
});

test('an overall drop with no sub-metric regression yields bench:overall p1', () => {
  const latest = row('2026-11-15T00:00:00.000Z', {}, { U: 5, L: 5, I: 5, D: 4, overall: 4 });
  const out = benchRegressions([prev, latest]);
  assert.deepEqual(out.map((r) => [r.fingerprint, r.priority]), [['bench:D', 'p1'], ['bench:overall', 'p1']]);
});

test('no regression gives no proposals; a single row gives none', () => {
  const same = row('2026-11-15T00:00:00.000Z');
  assert.deepEqual(benchRegressions([prev, same]), []);
  assert.deepEqual(benchRegressions([prev]), []);
});
