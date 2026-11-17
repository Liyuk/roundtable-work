import test from 'node:test';
import assert from 'node:assert/strict';
import { computeD } from '../scripts/rt-bench/metrics-d.mjs';

// D1-D5 from docs/autonomy-benchmark.md section 6; expected levels come from its level tables.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-17T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const fresh = (body) => ({ asOf: NOW - MIN, ...body });
// Production start 30 d back, so the window is the full 7 d (168 h).
const base = { now: NOW, productionStart: NOW - 30 * DAY };
const run = (id, sources) => computeD({ ...base, sources }).find((r) => r.id === id);

// Events one hour apart, the newest one hour before NOW.
const hourly = (n, extra = {}) => Array.from({ length: n }, (_, k) => ({ at: iso(NOW - (k + 1) * HOUR), ...extra }));

test('computeD returns D1..D5 in order with the result fields', () => {
  const res = computeD({ ...base, sources: {} });
  assert.deepEqual(res.map((r) => r.id), ['D1', 'D2', 'D3', 'D4', 'D5']);
  for (const r of res) {
    assert.ok('value' in r && 'level' in r && 'window' in r && 'measurable' in r && 'source' in r && Array.isArray(r.evidence), r.id);
  }
  assert.ok(res.every((r) => r.measurable === false && r.level === 0));
  assert.equal(res[0].window.start, iso(NOW - 7 * DAY));
});

test('a stale source (asOf older than 24 h) is not measurable', () => {
  const r = run('D1', { interventions: { asOf: NOW - 25 * HOUR, events: [] } });
  assert.equal(r.measurable, false);
  assert.equal(r.level, 0);
});

test('D1 decision interventions: 12 is level 1, 13 is level 0', () => {
  const cases = [[6, 2], [12, 1], [13, 0]];
  for (const [n, level] of cases) {
    const r = run('D1', { interventions: fresh({ events: hourly(n, { kind: 'decision' }) }) });
    assert.deepEqual([r.value, r.level], [n, level]);
  }
});

test('D1 counts decide, merge and close, and ignores other kinds', () => {
  const events = [...hourly(4, { kind: 'decide' }), ...hourly(4, { kind: 'merge' }), ...hourly(4, { kind: 'close' }), ...hourly(9, { kind: 'ask' })];
  assert.equal(run('D1', { interventions: fresh({ events }) }).value, 12);
});

test('D2 longest owner wait: red-line spans are skipped and open spans run to NOW', () => {
  const spans = [
    { issue: 1, label: 'rt:blocked', startedAt: iso(NOW - 20 * HOUR), endedAt: iso(NOW - 10 * HOUR), redLine: false }, // 10 h
    { issue: 2, label: 'rt:ask', startedAt: iso(NOW - 80 * HOUR), endedAt: iso(NOW - 10 * HOUR), redLine: true }, // skipped
  ];
  const r = run('D2', { waits: fresh({ spans }) });
  assert.equal(r.value, 10);
  assert.equal(r.level, 4); // 10 h is above 4 h and at or under 12 h
  assert.equal(r.measurable, true);
});

test('D2 open wait of 13.6 h is level 3, 4 h is level 5', () => {
  const open = (h) => [{ issue: 3, label: 'rt:blocked', startedAt: iso(NOW - h * HOUR), endedAt: null, redLine: false }];
  assert.equal(run('D2', { waits: fresh({ spans: open(13.6) }) }).level, 3);
  assert.equal(run('D2', { waits: fresh({ spans: open(4) }) }).level, 5);
});

test('D2 clips a span to the window', () => {
  const spans = [{ issue: 4, label: 'rt:ask', startedAt: iso(NOW - 200 * HOUR), endedAt: iso(NOW - 100 * HOUR), redLine: false }];
  assert.equal(run('D2', { waits: fresh({ spans }) }).value, 68); // 168 h window minus the 100 h before it started
});

test('D2 without a waits source is not measurable', () => {
  const r = run('D2', {});
  assert.equal(r.measurable, false);
  assert.equal(r.level, 0);
  assert.equal(typeof r.evidence[0].reason, 'string');
});

// Verdicts in W, `counts` gives how many of each.
const verdicts = (counts) => ({ events: Object.entries(counts).flatMap(([verdict, n]) => Array.from({ length: n }, () => ({ at: iso(NOW - MIN), verdict }))) });

test('D3 self-settled: the doc example 65 / 86 is 75.6% and level 1; fallback and timeout-default are not counted', () => {
  const r = run('D3', { decisions: fresh(verdicts({ resolve: 65, 'ask-owner': 6, stop: 10, invalid: 5, fallback: 20, 'timeout-default': 20 })) });
  assert.equal(Math.round(r.value * 10) / 10, 75.6);
  assert.equal(r.level, 1);
});

test('D3 level boundaries: 60% is level 1, 80% level 2, 90% level 3, 98% level 5, 50% level 0', () => {
  const cases = [[{ resolve: 3, 'ask-owner': 2 }, 1], [{ resolve: 8, 'ask-owner': 2 }, 2], [{ resolve: 9, 'ask-owner': 1 }, 3], [{ resolve: 49, 'ask-owner': 1 }, 5], [{ resolve: 2, 'ask-owner': 2 }, 0]];
  for (const [counts, level] of cases) {
    assert.equal(run('D3', { decisions: fresh(verdicts(counts)) }).level, level, JSON.stringify(counts));
  }
});

test('D3 without a decisions source is not measurable', () => {
  const r = run('D3', {});
  assert.equal(r.measurable, false);
  assert.equal(r.level, 0);
});

test('D3 with only fallback verdicts has no denominator and is not measurable', () => {
  const r = run('D3', { decisions: fresh(verdicts({ fallback: 3 })) });
  assert.equal(r.value, null);
  assert.equal(r.measurable, false);
});

// `loop` loop merges (pr 1..loop), `human` and `bot` merges, and `reverts` revert PRs of loop merges 1..reverts; all in W.
function merges({ loop = 0, human = 0, bot = 0, reverts = 0 }) {
  const events = [];
  for (let k = 1; k <= loop; k++) events.push({ at: iso(NOW - k * HOUR), pr: k, by: 'loop' });
  for (let k = 1; k <= human; k++) events.push({ at: iso(NOW - k * HOUR), pr: 500 + k, by: 'human' });
  for (let k = 1; k <= bot; k++) events.push({ at: iso(NOW - k * HOUR), pr: 700 + k, by: 'bot' });
  for (let k = 1; k <= reverts; k++) events.push({ at: iso(NOW - k * HOUR), pr: 900 + k, by: 'human', revertOf: k });
  return fresh({ events });
}

test('D4 rollback: a revert removes its target from the loop-merge denominator', () => {
  const r = run('D4', { merges: merges({ loop: 20, reverts: 1 }) });
  assert.equal(r.value, 100 / 19); // 1 revert over 19 good loop merges, not 20
});

test('D4 level boundaries with n >= 20: 0% is level 5, 2.0% level 4, 7.1% level 2, 20% level 0', () => {
  const cases = [[100, 0, 5], [100, 2, 4], [30, 1, 4], [30, 2, 2], [100, 20, 0]]; // [loop, reverts, level]
  for (const [loop, reverts, level] of cases) {
    assert.equal(run('D4', { merges: merges({ loop, reverts }) }).level, level, `${reverts} of ${loop}`);
  }
});

test('D4 with fewer than 20 loop merges caps the level at 4', () => {
  const r = run('D4', { merges: merges({ loop: 19 }) });
  assert.equal(r.value, 0);
  assert.equal(r.level, 4);
});

test('D4 without loop merges is not measurable', () => {
  const r = run('D4', { merges: merges({ human: 3 }) });
  assert.equal(r.value, null);
  assert.equal(r.measurable, false);
});

test('D5 loop-merged share: 92% is level 2, 93% level 3', () => {
  assert.equal(run('D5', { merges: merges({ loop: 92, human: 8 }) }).level, 2);
  assert.equal(run('D5', { merges: merges({ loop: 93, human: 7 }) }).level, 3);
});

test('D5 excludes bot merges from the denominator', () => {
  const r = run('D5', { merges: merges({ loop: 9, human: 1, bot: 50 }) });
  assert.equal(r.value, 90);
  assert.equal(r.level, 2);
});

test('D5 reverts remove their target: 20 loop merges with one revert is 100%, level 5', () => {
  const r = run('D5', { merges: merges({ loop: 20, reverts: 1 }) });
  assert.equal(r.value, 100);
  assert.equal(r.level, 5);
});

test('D5 with only bot merges is not measurable', () => {
  const r = run('D5', { merges: merges({ bot: 5 }) });
  assert.equal(r.value, null);
  assert.equal(r.measurable, false);
});
