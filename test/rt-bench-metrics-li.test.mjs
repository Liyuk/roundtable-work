import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLI } from '../scripts/rt-bench/metrics-li.mjs';

// L1-L5 and I1-I5 from docs/autonomy-benchmark.md sections 4-5; expected levels come from their level tables.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-17T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const fresh = (events) => ({ asOf: NOW - MIN, events });
const base = { now: NOW, productionStart: NOW - 30 * DAY }; // full 7 d window
const run = (id, sources) => computeLI({ ...base, sources }).find((r) => r.id === id);

const issue = (number, { labels = ['rt:self'], body = '', closedAt, createdAt = iso(NOW - HOUR) } = {}) => ({ number, labels, body, createdAt, closedAt, stateReason: closedAt ? 'completed' : undefined });
const pr = (number, { closes = [], mergedAt, title = `PR ${number}`, revertOf } = {}) => ({ number, title, headRef: `b${number}`, closes, mergedAt, revertOf });
const gh = (issues, prs) => ({ asOf: NOW - MIN, issues, prs });
const ago = (h) => iso(NOW - h * HOUR);

test('computeLI returns L1..L5 and I1..I5 in order with the result fields', () => {
  const res = computeLI({ ...base, sources: {} });
  assert.deepEqual(res.map((r) => r.id), ['L1', 'L2', 'L3', 'L4', 'L5', 'I1', 'I2', 'I3', 'I4', 'I5']);
  for (const r of res) {
    assert.ok('value' in r && 'level' in r && 'window' in r && 'measurable' in r && 'source' in r && Array.isArray(r.evidence), r.id);
  }
  assert.ok(res.every((r) => r.measurable === false && r.level === 0));
});

test('L1 days with self merges: 1 day is level 1, 2 days level 2, 4 days level 3, 6 days level 4, 7 days level 5', () => {
  // Self issue k is merged 1 h into slice k (NOW - 24(k+1) h, NOW - 24k h].
  const cases = [[0, 0], [1, 1], [2, 2], [3, 2], [4, 3], [5, 3], [6, 4], [7, 5]];
  for (const [n, level] of cases) {
    const issues = Array.from({ length: n }, (_, k) => issue(100 + k));
    const prs = Array.from({ length: n }, (_, k) => pr(200 + k, { closes: [100 + k], mergedAt: ago(24 * k + 1) }));
    const r = run('L1', { github: gh(issues, prs) });
    assert.deepEqual([r.value, r.level], [n, level], `${n} days`);
  }
});

test('L2 self acceptance: 20% is level 1, 0% level 0, 40% level 2; closes without a merged PR do not count', () => {
  // 5 self issues closed in W. Accepted = k of them backed by a merged PR; the others are closed with no PR.
  const cases = [[0, 0], [1, 1], [2, 2]];
  for (const [k, level] of cases) {
    const issues = Array.from({ length: 5 }, (_, i) => issue(100 + i, { closedAt: ago(i + 1) }));
    const prs = Array.from({ length: k }, (_, i) => pr(200 + i, { closes: [100 + i], mergedAt: ago(i + 1) }));
    const r = run('L2', { github: gh(issues, prs) });
    assert.deepEqual([r.value, r.level], [k * 20, level], `${k} of 5 accepted`);
  }
});

test('L2 a merged PR later reverted does not accept its issue', () => {
  const issues = [issue(100, { closedAt: ago(5) }), issue(101, { closedAt: ago(5) })];
  const prs = [
    pr(200, { closes: [100], mergedAt: ago(6) }),
    pr(201, { closes: [101], mergedAt: ago(6) }),
    pr(202, { title: 'Revert "PR 200"', revertOf: 200, mergedAt: ago(4) }),
  ];
  assert.equal(run('L2', { github: gh(issues, prs) }).value, 50);
});

test('L3 self share: 5% is level 1, 10% level 2, 15% level 3; 0 self merges is level 0', () => {
  // 20 loop merges; `self` of them close a self issue, the rest close nothing.
  const cases = [[0, 0], [1, 1], [2, 2], [3, 3]];
  for (const [self, level] of cases) {
    const issues = Array.from({ length: self }, (_, i) => issue(100 + i));
    const prs = Array.from({ length: 20 }, (_, i) => pr(200 + i, { closes: [i < self ? 100 + i : 900 + i], mergedAt: ago(i + 1) }));
    const r = run('L3', { github: gh(issues, prs) });
    assert.deepEqual([r.value, r.level], [(self * 100) / 20, level], `${self} of 20`);
  }
});

test('L3 and L1: a child of a decomposition (Parent: #N) does not count; two merges of one issue within 24 h count once', () => {
  const issues = [issue(100, { body: 'Parent: #7' }), issue(101), issue(102)];
  const prs = [
    pr(200, { closes: [100], mergedAt: ago(1) }), // child: not self-originated
    pr(201, { closes: [101], mergedAt: ago(2) }), // self, first merge
    pr(202, { closes: [101], mergedAt: ago(5) }), // self, second merge within 24 h: counted once
    pr(203, { closes: [102], mergedAt: ago(30) }), // self, another day
  ];
  const github = gh(issues, prs);
  assert.equal(run('L1', { github }).value, 2);
  // Loop merges: 203, 202 (201 is the second merge of issue 101, counted once) and the child 200 = 3; self ones = 2.
  assert.equal(Math.round(run('L3', { github }).value), 67);
});

test('L2 and L3 with a revert: the reverted merge and the revert PR are removed from every count', () => {
  const issues = [issue(100, { closedAt: ago(3) })];
  const prs = [
    pr(200, { closes: [100], mergedAt: ago(4) }),
    pr(201, { closes: [900], mergedAt: ago(4) }),
    pr(202, { title: 'Revert "PR 200"', revertOf: 200, mergedAt: ago(2) }),
  ];
  const github = gh(issues, prs);
  assert.deepEqual([run('L3', { github }).value, run('L1', { github }).value], [0, 0]);
  assert.equal(run('L2', { github }).value, 0);
});

test('L4 externally filed issues per day: 12 per day is level 1, 12.14 level 0, 6 level 2, none level 5', () => {
  const cases = [[84, 1], [85, 0], [42, 2], [0, 5]];
  for (const [n, level] of cases) {
    const issues = Array.from({ length: n }, (_, i) => issue(100 + i, { labels: ['rt:owner'] }));
    const r = run('L4', { github: gh(issues, []) });
    assert.deepEqual([r.value, r.level], [n / 7, level], `${n} issues`);
  }
});

test('L4 ignores rt:self and rt:followup issues', () => {
  const issues = [issue(1), issue(2, { labels: ['rt:followup'] }), issue(3, { labels: ['rt:owner'] })];
  assert.equal(run('L4', { github: gh(issues, []) }).value, 1 / 7);
});

test('L5 idle hours (proxy): 25 idle h is level 0, 24 is level 1, 12 is level 2', () => {
  // One worker runs for `busy` h inside the 168 h window; idle = 168 - busy.
  const cases = [[143, 0], [144, 1], [156, 2]];
  for (const [busy, level] of cases) {
    const at = [iso(NOW - 168 * HOUR), iso(NOW - (168 - busy) * HOUR)];
    const sched = fresh([{ kind: 'spawn', at: at[0], worker: 1, slot: 0 }, { kind: 'stage', at: at[1], worker: 1, rc: 0, finalState: 'done' }]);
    const r = run('L5', { sched });
    assert.deepEqual([r.value, r.level, r.proxy], [168 - busy, level, true], `${busy} h busy`);
  }
});

test('I1 PR-shipped changes: 20% is level 1, 0% level 0, 100% level 5; no changes is not measurable', () => {
  const cases = [[1, 4, 1], [0, 1, 0], [5, 0, 5]];
  for (const [prs, hand, level] of cases) {
    const deploys = [...Array.from({ length: prs }, (_, i) => ({ at: ago(i + 1), kind: 'pr', pr: 300 + i })), ...Array.from({ length: hand }, (_, i) => ({ at: ago(i + 1), kind: 'hand', tag: `t${i}` }))];
    const r = run('I1', { deploys: fresh(deploys) });
    assert.deepEqual([r.value, r.level], [(prs * 100) / (prs + hand), level], `${prs} pr, ${hand} hand`);
  }
  assert.deepEqual([run('I1', { deploys: fresh([]) }).value, run('I1', { deploys: fresh([]) }).measurable], [null, false]);
});

test('I2 hand patches: 12 distinct tags is level 1, 13 level 0, none level 5', () => {
  const cases = [[12, 1], [13, 0], [0, 5]];
  for (const [n, level] of cases) {
    const patches = Array.from({ length: n }, (_, i) => ({ at: ago(i + 1), tag: `patch-${i}` }));
    const r = run('I2', { handPatches: fresh(patches) });
    assert.deepEqual([r.value, r.level], [n, level]);
  }
});

test('I3 repeat-failure closure: a signature with 3 occurrences is closed by loop activity within 24 h of the 3rd', () => {
  // A: 3 occurrences, activity 6 h after the 3rd (closed). B: 3 occurrences, activity 25 h after the 3rd (open).
  // C: 2 occurrences, does not qualify.
  const failures = [
    { at: ago(50), signature: 'A', issue: 1 }, { at: ago(40), signature: 'A', issue: 1 }, { at: ago(30), signature: 'A', issue: 1 },
    { at: ago(50), signature: 'B', issue: 2 }, { at: ago(40), signature: 'B', issue: 2 }, { at: ago(30), signature: 'B', issue: 2 },
    { at: ago(20), signature: 'C', issue: 3 }, { at: ago(10), signature: 'C', issue: 3 },
  ];
  const issueActivity = [{ at: ago(24), issue: 9, signature: 'A' }, { at: ago(5), issue: 9, signature: 'B' }];
  const r = run('I3', { failures: fresh(failures), issueActivity: fresh(issueActivity) });
  assert.deepEqual([r.value, r.level], [50, 2]);
});

test('I3 with no signature at 3 occurrences is not measurable', () => {
  const r = run('I3', { failures: fresh([{ at: ago(1), signature: 'A', issue: 1 }]), issueActivity: fresh([]) });
  assert.deepEqual([r.value, r.measurable], [null, false]);
});

// A change is due for evaluation at mergedAt + 7 d; the I4 window applies to that point (see header).
const due = (i) => NOW - (i + 1) * HOUR;
const change = (i, { preRegistered = true, evalDays = 7 } = {}) => ({
  pr: 400 + i, metric: 'm', preRegistered, mergedAt: iso(due(i) - 7 * DAY), evaluatedAt: iso(due(i) - 7 * DAY + evalDays * DAY), verdict: 'kept',
});

test('I4 measured changes: a pre-registered change evaluated 7 d after merge is kept; 4 of 5 is level 4', () => {
  const cases = [[1, 1], [4, 4], [5, 5]];
  for (const [n, level] of cases) {
    const rows = Array.from({ length: 5 }, (_, i) => change(i, { preRegistered: i < n }));
    const r = run('I4', { changeEvals: fresh(rows) });
    assert.deepEqual([r.value, r.level, r.measurable], [n * 20, level, true], `${n} of 5`);
  }
});

test('I4 a change evaluated after 6 d is not kept', () => {
  assert.equal(run('I4', { changeEvals: fresh([change(0, { evalDays: 6 })]) }).value, 0);
});

test('I5 first-pass rate: 0.95 with n >= 20 is level 5; the same value with n < 20 is capped at level 4', () => {
  const day = (first, rework) => ({ day: '2026-11-16', first_pass_n: first, rework_n: rework });
  const big = run('I5', { daily: fresh([day(19, 1)]) });
  assert.deepEqual([big.value, big.level], [0.95, 5]);
  const small = run('I5', { daily: fresh([day(19, 0)]) });
  assert.deepEqual([small.value, small.level], [1, 4]);
});

test('missing sources give level 0 and not measurable; I4 with no changes is not measurable', () => {
  const stale = run('L4', { github: { asOf: NOW - DAY - 1, issues: [], prs: [] } });
  assert.deepEqual([stale.measurable, stale.level], [false, 0]);
  const none = run('I4', { changeEvals: fresh([]) });
  assert.deepEqual([none.value, none.measurable, none.level], [null, false, 0]);
});
