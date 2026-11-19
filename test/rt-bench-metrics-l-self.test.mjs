import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLSelf } from '../scripts/rt-bench/metrics-l-self.mjs';

// L6-L8 from docs/autonomy-benchmark.md section 4; expected levels come from their level tables.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-17T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const base = { now: NOW, productionStart: NOW - 30 * DAY }; // full 7 d window
const gh = (issues, prs = [], asOf = NOW - MIN) => ({ asOf, issues, prs });
const run = (id, github, lowestIds = ['L2']) => computeLSelf({ ...base, sources: { github }, lowestIds }).find((r) => r.id === id);

const issue = (number, { body = '', labels = ['rt:self'], createdAt = iso(NOW - HOUR), closedAt, stateReason } = {}) => ({ number, labels, body, createdAt, closedAt, stateReason });
const pr = (number, { closes = [], mergedAt = iso(NOW - HOUR), title = `PR ${number}`, revertOf } = {}) => ({ number, title, closes, mergedAt, revertOf });
const bench = (target) => `Bench: ${target} score 1 -> 2\n`;
const old = iso(NOW - 2 * DAY); // created before the 24 h settle point

test('computeLSelf returns L6, L7, L8 in order as unmeasurable level 0 with no source', () => {
  const res = computeLSelf({ ...base, sources: {}, lowestIds: [] });
  assert.deepEqual(res.map((r) => r.id), ['L6', 'L7', 'L8']);
  for (const r of res) {
    assert.ok('value' in r && 'level' in r && 'window' in r && 'measurable' in r && 'source' in r && Array.isArray(r.evidence), r.id);
  }
  assert.ok(res.every((r) => r.measurable === false && r.level === 0));
});

test('L6 targeting: a self issue on a lowest sub-metric counts; 20% is level 1, 60% level 3, 100% level 5 with cohort 5', () => {
  // Five self issues created in W; k of them target L2, which is in lowestIds.
  for (const [k, level] of [[1, 1], [3, 3], [5, 5]]) {
    const issues = Array.from({ length: 5 }, (_, i) => issue(100 + i, { body: bench(i < k ? 'L2' : 'L4') }));
    const r = run('L6', gh(issues));
    assert.deepEqual([r.value, r.level, r.measurable], [k * 20, level, true], `${k} of 5 targeted`);
  }
});

test('L6 a self issue whose Bench target is not in lowestIds does not raise L6', () => {
  const issues = Array.from({ length: 5 }, (_, i) => issue(100 + i, { body: bench('I3') }));
  const r = run('L6', gh(issues), ['L2']);
  assert.deepEqual([r.value, r.level], [0, 0]);
});

test('L6 cohort below 5 caps the level at 4; a PR-less or non-self issue is not in the cohort', () => {
  const four = Array.from({ length: 4 }, (_, i) => issue(100 + i, { body: bench('L2') }));
  assert.deepEqual([run('L6', gh(four)).value, run('L6', gh(four)).level], [100, 4]);
  const withParent = [...four, issue(200, { body: `Parent: #7\n${bench('L2')}` })];
  assert.equal(run('L6', gh(withParent)).value, 100);
});

test('L6 is not measurable with an empty cohort or a missing or stale github source', () => {
  assert.deepEqual([run('L6', gh([])).measurable, run('L6', gh([])).level], [false, 0]);
  const issues = [issue(100, { body: bench('L2') })];
  const missing = run('L6', { issues, prs: [] });
  assert.deepEqual([missing.measurable, missing.level], [false, 0]);
  const stale = run('L6', gh(issues, [], NOW - 2 * DAY));
  assert.deepEqual([stale.measurable, stale.level], [false, 0]);
});

test('L7 completion: 20% is level 1, 60% level 3, 80% level 5 with cohort 5; a closing PR must be good', () => {
  // Five self issues created two days ago; k have a merged PR closing them, one more has a reverted PR.
  for (const [k, level] of [[1, 1], [3, 3], [4, 5]]) {
    const issues = Array.from({ length: 5 }, (_, i) => issue(100 + i, { createdAt: old }));
    const prs = Array.from({ length: k }, (_, i) => pr(200 + i, { closes: [100 + i] }));
    const r = run('L7', gh(issues, prs));
    assert.deepEqual([r.value, r.level, r.measurable], [k * 20, level, true], `${k} of 5 completed`);
  }
  const reverted = [pr(200, { closes: [100] }), pr(201, { title: 'Revert "PR 200"', revertOf: 200, closes: [] })];
  assert.equal(run('L7', gh([issue(100, { createdAt: old })], reverted)).value, 0);
});

test('L7 excludes issues younger than 24 h: unfinished young issues do not lower the rate', () => {
  const old5 = Array.from({ length: 5 }, (_, i) => issue(100 + i, { createdAt: old }));
  const young = Array.from({ length: 5 }, (_, i) => issue(110 + i, { createdAt: iso(NOW - HOUR) }));
  const prs = Array.from({ length: 5 }, (_, i) => pr(200 + i, { closes: [100 + i] }));
  const r = run('L7', gh([...old5, ...young], prs));
  assert.deepEqual([r.value, r.level], [100, 5]);
  assert.equal(run('L7', gh(young, [])).measurable, false);
});

test('L8 invalid/duplicate: 0% is level 5, 20% is level 1; open issues do not count, closed duplicate/invalid/not_planned do', () => {
  const open = issue(104, { labels: ['rt:self', 'invalid'], createdAt: old }); // open: not invalid
  const clean = Array.from({ length: 4 }, (_, i) => issue(100 + i, { createdAt: old, closedAt: iso(NOW - HOUR), stateReason: 'completed' }));
  const r0 = run('L8', gh([...clean, open]));
  assert.deepEqual([r0.value, r0.level], [0, 5]);
  const bad = issue(105, { createdAt: old, closedAt: iso(NOW - HOUR), stateReason: 'not_planned' });
  const dup = issue(106, { labels: ['rt:self', 'duplicate'], createdAt: old, closedAt: iso(NOW - HOUR), stateReason: 'completed' });
  const r1 = run('L8', gh([...clean, bad, dup]));
  assert.deepEqual([r1.value, r1.level], [100 * 2 / 6, 0]);
  const r2 = run('L8', gh([...clean.slice(0, 4), bad]));
  assert.deepEqual([r2.value, r2.level], [20, 1]);
});

test('L8 cohort below 5 caps the level at 4; not measurable when the cohort is empty or the source is stale', () => {
  const four = Array.from({ length: 4 }, (_, i) => issue(100 + i, { createdAt: old, closedAt: iso(NOW - HOUR), stateReason: 'completed' }));
  assert.deepEqual([run('L8', gh(four)).value, run('L8', gh(four)).level], [0, 4]);
  assert.deepEqual([run('L8', gh([])).measurable, run('L8', gh([])).level], [false, 0]);
  const stale = run('L8', gh(four, [], NOW - 2 * DAY));
  assert.deepEqual([stale.measurable, stale.level], [false, 0]);
});
