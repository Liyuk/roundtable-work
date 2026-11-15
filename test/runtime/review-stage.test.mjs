import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDoneWhen, validateEvidence, reviewOutcome, park, buildReviewerInput, reviewSnapshotArgs, usesReviewer } from '../../runtime/lib/review-stage.mjs';

const sha = n => String(n).padStart(40, '0');
const doneWhen = ['tests pass', 'docs updated'];
const task = (extra = {}) => ({ id: '486', state: 'review', ...extra });

test('doneWhen must be a non-empty array of non-empty strings', () => {
  assert.doesNotThrow(() => validateDoneWhen(doneWhen));
  for (const bad of [undefined, [], ['ok', ''], 'tests pass']) assert.throws(() => validateDoneWhen(bad), TypeError);
});

test('worker evidence has exactly one non-empty entry per criterion, and the error names the index', () => {
  const ev = (...entries) => ({ evidence: entries });
  assert.doesNotThrow(() => validateEvidence(doneWhen, ev({ criterion: 0, evidence: 'npm test exit 0' }, { criterion: 1, evidence: 'docs diff' })));
  assert.throws(() => validateEvidence(doneWhen, ev({ criterion: 0, evidence: 'npm test exit 0' })), /criterion 1/);
  assert.throws(() => validateEvidence(doneWhen, ev({ criterion: 0, evidence: 'a' }, { criterion: 0, evidence: 'b' })), /criterion 0/);
  assert.throws(() => validateEvidence(doneWhen, ev({ criterion: 0, evidence: 'a' }, { criterion: 2, evidence: 'b' })), /criterion 2/);
  assert.throws(() => validateEvidence(doneWhen, ev({ criterion: 0, evidence: 'a' }, { criterion: 1, evidence: '' })), TypeError);
});

test('pass moves a task to accepted', () => {
  assert.equal(reviewOutcome(task(), 'pass').state, 'accepted');
});

test('reject reworks twice, then the third rejection goes to needs-owner', () => {
  const first = reviewOutcome(task(), 'reject');
  assert.deepEqual([first.state, first.reworks], ['rework', 1]);
  const second = reviewOutcome(first, 'reject');
  assert.deepEqual([second.state, second.reworks], ['rework', 2]);
  const third = reviewOutcome(second, 'reject');
  assert.equal(third.state, 'needs-owner');
});

test('park is an explicit action and parked is terminal', () => {
  assert.equal(park(task()).state, 'parked');
  assert.throws(() => reviewOutcome(park(task()), 'pass'), TypeError);
  assert.throws(() => reviewOutcome({ state: 'accepted' }, 'reject'), TypeError);
});

test('no transition yields a closed state', () => {
  const states = new Set();
  const walk = (t, depth) => {
    states.add(t.state);
    if (depth === 0 || ['accepted', 'needs-owner', 'parked'].includes(t.state)) return;
    walk(reviewOutcome(t, 'pass'), depth - 1);
    walk(reviewOutcome(t, 'reject'), depth - 1);
  };
  walk(task(), 6);
  walk(park(task()), 0);
  assert.ok([...states].every(s => ['review', 'rework', 'accepted', 'needs-owner', 'parked'].includes(s)));
  assert.ok(!states.has('closed'));
});

test('reviewer input is exactly { diff, doneWhen } and drops transcript or worker messages', () => {
  const sentinel = 'TRANSCRIPT-SENTINEL-7f3a';
  const input = buildReviewerInput({ diff: 'diff --git a/x b/x', doneWhen, transcript: sentinel, workerMessage: sentinel });
  assert.deepEqual(Object.keys(input).sort(), ['diff', 'doneWhen']);
  assert.ok(!JSON.stringify(input).includes(sentinel));
  assert.throws(() => buildReviewerInput({ diff: 1, doneWhen }), TypeError);
  assert.throws(() => buildReviewerInput({ diff: '', doneWhen: [] }), TypeError);
});

test('snapshot argv is a git argv array and rejects bad head or dir', () => {
  assert.deepEqual(reviewSnapshotArgs({ head: sha(1), dir: '/tmp/snap' }), ['worktree', 'add', '--detach', '/tmp/snap', sha(1)]);
  assert.deepEqual(reviewSnapshotArgs({ head: sha(1).padEnd(64, '0'), dir: '/tmp/snap' }).at(-1), sha(1).padEnd(64, '0'));
  assert.throws(() => reviewSnapshotArgs({ head: 'main', dir: '/tmp/snap' }), TypeError);
  assert.throws(() => reviewSnapshotArgs({ head: sha(1), dir: 'snap' }), TypeError);
  assert.throws(() => reviewSnapshotArgs({ head: sha(1), dir: '/tmp/../etc' }), TypeError);
});

test('the reviewer path is off by default and only on for optionalReviewer === true', () => {
  assert.equal(usesReviewer(task()), false);
  assert.equal(usesReviewer(task({ optionalReviewer: false })), false);
  assert.equal(usesReviewer(task({ optionalReviewer: 'true' })), false);
  assert.equal(usesReviewer(task({ optionalReviewer: true })), true);
});
