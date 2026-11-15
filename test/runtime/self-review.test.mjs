import test from 'node:test';
import assert from 'node:assert/strict';
import { proposals, parseInventoryOpenRows, parseCaseImprovements } from '../../runtime/lib/self-review.mjs';

// Seam: proposals(input) and the two markdown parsers. Expected fingerprints are literals computed
// independently with sha256sum over "<rule>:<key>", first 12 hex characters.
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T00:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString();
const marker = (fp) => `<!-- rt:fingerprint ${fp} -->`;

const goals = {
  metrics: { windowDays: 7, mtbiHoursMin: 24, firstPassRateMin: 0.8, ownerPullInsPerWeekMax: 3 },
  selfReview: { cadenceHours: 24, maxPerDay: 3, maxOpen: 5, hostPatchMaxAgeDays: 3, failureRepeat: { count: 3, days: 7 } },
};

const empty = {
  goals,
  metrics: { mtbiHours: [30, 30], firstPassRate: [0.9, 0.9], ownerPullInsPerWeek: [1, 1] },
  interventions: [],
  failures: [],
  inventory: '',
  openIssues: [],
  cases: [],
  now: NOW,
};
const run = (input) => proposals({ ...empty, ...input });
const rules = (list) => list.map((c) => c.rule);

test('T1 failure-repeat: count reached in window with no open marker gives one candidate', () => {
  const failures = [1, 2, 3].map((d) => ({ class: 'audit', at: ago(d), ref: `#${d}` }));
  const out = run({ failures }); const [c] = out; assert.equal(out.length, 1);
  assert.deepEqual(rules([c]), ['T1']);
  assert.equal(c.fingerprint, 'fb0789d9553e');
  assert.deepEqual(c.evidence, ['#1', '#2', '#3']);
  assert.equal(run({ failures: failures.slice(0, 2) }).length, 0);
  assert.equal(run({ failures: [...failures.slice(0, 2), { class: 'audit', at: ago(9), ref: '#9' }] }).length, 0);
  assert.equal(run({ failures, openIssues: [{ number: 5, labels: [], body: marker('fb0789d9553e') }] }).length, 0);
});

test('T2 host-patch-age: old unfollowed self-repair gives one candidate; young or followed gives none', () => {
  const old = { id: 'iv:1', at: ago(5), category: 'self-repair', ref: 'patch:tagx', internalized: 'no', source: 'owner' };
  const out = run({ interventions: [old] }); const [c] = out; assert.equal(out.length, 1);
  assert.deepEqual(rules([c]), ['T2']);
  assert.deepEqual(c.evidence, ['iv:1', 'patch:tagx']);
  assert.equal(run({ interventions: [{ ...old, at: ago(1) }] }).length, 0);
  assert.equal(run({ interventions: [{ ...old, followUp: '#7' }], openIssues: [{ number: 7, labels: [], body: '' }] }).length, 0);
});

test('T3 intervention-repeat: two counted interventions in a category give one candidate', () => {
  const iv = (id, extra = {}) => ({ id, at: ago(2), category: 'liveness', ref: 'none', internalized: 'no', source: 'owner', ...extra });
  const pair = [iv('a'), iv('b')];
  const out = run({ interventions: pair }); const [c] = out; assert.equal(out.length, 1);
  assert.deepEqual(rules([c]), ['T3']);
  assert.deepEqual(c.evidence, ['a', 'b']);
  assert.equal(run({ interventions: [iv('a')] }).length, 0);
  assert.equal(run({ interventions: [iv('a', { category: 'owner-only' }), iv('b', { category: 'owner-only' })] }).length, 0);
  const filed = { number: 9, labels: ['source:self'], body: marker(c.fingerprint) };
  assert.equal(run({ interventions: pair, openIssues: [filed] }).length, 0);
});

test('T4 metric-breach: a breach in two consecutive windows gives one candidate; a single breach gives none', () => {
  const out = run({ metrics: { mtbiHours: [30, 20, 18], firstPassRate: [0.9, 0.9], ownerPullInsPerWeek: [1, 1] } }); const [c] = out; assert.equal(out.length, 1);
  assert.deepEqual(rules([c]), ['T4']);
  assert.equal(c.fingerprint, '0a245b28137f');
  assert.equal(run({ metrics: { mtbiHours: [30, 30, 18], firstPassRate: [0.9, 0.9], ownerPullInsPerWeek: [1, 1] } }).length, 0);
});

const INVENTORY = [
  '# Inventory',
  '',
  '| Tag class | Behavior | Mapping |',
  '|---|---|---|',
  '| alpha | Does a thing. | `runtime/lib/x.mjs` + `test/runtime/x.test.mjs` :: works |',
  '| beta | Does another thing. | not ported: no runtime counterpart |',
  '| gamma | Tracked elsewhere. | not ported: waits for #12 |',
  '| delta | Old. | superseded by #303 |',
].join('\n');

test('T5 inventory-open: parses only not-ported rows with no #<n> and yields one candidate each', () => {
  assert.deepEqual(parseInventoryOpenRows(INVENTORY), [{ tag: 'beta', reason: 'not ported: no runtime counterpart' }]);
  const out = run({ inventory: INVENTORY }); const [c] = out; assert.equal(out.length, 1);
  assert.deepEqual(rules([c]), ['T5']);
  assert.deepEqual(c.evidence, ['beta']);
});

const CASE = [
  '# Case 1',
  '',
  '## Improvements',
  '',
  '1. Add a parser test for the tag column.',
  '2. Track the retry gap in #41.',
  '3. Document the window rule',
  '   with a note.',
  '',
  '## Notes',
  '4. Not an improvement.',
].join('\n');

test('T6 heading: numbered heading form "## 4. Improvements, ranked by benefit" is matched', () => {
  const md = ['## 4. Improvements, ranked by benefit', '', '1. Fix A (#41).', '2. Fix B without issue.'].join('\n');
  assert.deepEqual(parseCaseImprovements(md), [{ n: 2, text: 'Fix B without issue.' }]);
});

test('T6 window: only cases changed in the last 30 days produce candidates', () => {
  assert.equal(run({ cases: [{ file: 'docs/cases/old.md', markdown: CASE, changedAt: ago(90) }] }).length, 0);
  assert.deepEqual(rules(run({ cases: [{ file: 'docs/cases/new.md', markdown: CASE, changedAt: ago(5) }] })), ['T6', 'T6']);
});

test('T6 case-improvement: numbered items under Improvements with no #<n> are returned', () => {
  assert.deepEqual(parseCaseImprovements(CASE), [
    { n: 1, text: 'Add a parser test for the tag column.' },
    { n: 3, text: 'Document the window rule with a note.' },
  ]);
  const out = run({ cases: [{ file: 'docs/cases/c1.md', markdown: CASE, changedAt: ago(1) }] });
  assert.deepEqual(rules(out), ['T6', 'T6']);
  assert.deepEqual(out[0].evidence, ['docs/cases/c1.md item 1']);
});

test('output is ordered T1 to T6 across rules', () => {
  const out = run({
    failures: [1, 2, 3].map((d) => ({ class: 'audit', at: ago(d), ref: `#${d}` })),
    metrics: { mtbiHours: [20, 18], firstPassRate: [0.9, 0.9], ownerPullInsPerWeek: [1, 1] },
    inventory: INVENTORY,
    cases: [{ file: 'docs/cases/c1.md', markdown: CASE, changedAt: ago(1) }],
  });
  assert.deepEqual(rules(out), ['T1', 'T4', 'T5', 'T6', 'T6']);
});
