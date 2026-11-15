import test from 'node:test';
import assert from 'node:assert/strict';
import { nextMergeable, mergeOne } from '../../runtime/lib/merge-order.mjs';

// Scripted fakes: `syncs` is the queue of mergeBase outcomes (default up-to-date); each push moves the head.
function fakeGit(syncs = []) {
  const calls = [];
  let pushes = 0;
  const git = {
    async mergeBase(base) { calls.push(['mergeBase', base]); return syncs.shift() ?? 'up-to-date'; },
    async mergeAbort() { calls.push(['mergeAbort']); },
    async push() { pushes++; calls.push(['push']); },
    async head() { return `head-${pushes}`; },
  };
  return { git, calls };
}

function fakeGates(calls, failing = new Set()) {
  return {
    async run(head) { calls.push(['checks', head]); return !failing.has(head); },
  };
}

const merge = (calls, accept = true) => async ({ pr, head }) => { calls.push(['merge', pr, head]); return accept; };
const cleanup = (calls) => async (issue) => { calls.push(['cleanup', issue]); return { removed: true }; };

test('nextMergeable picks the first PR whose dependencies are all merged', () => {
  const prs = [
    { number: 11, body: 'Depends on #10' },
    { number: 12, body: 'Blocked by #11' },
    { number: 13, body: 'no links' },
  ];
  assert.equal(nextMergeable(prs, new Set()).number, 13);
  assert.equal(nextMergeable(prs, new Set([10])).number, 11);
  assert.equal(nextMergeable(prs.slice(1), new Set([10, 11])).number, 12);
});

test('nextMergeable returns null while every PR waits on an unmerged dependency', () => {
  const prs = [{ number: 21, body: 'Blocked by #20' }, { number: 22, body: 'Depends on #20' }];
  assert.equal(nextMergeable(prs, new Set()), null);
});

test('base already up to date: checks the head, then merges and cleans up', async () => {
  const { git, calls } = fakeGit();
  const result = await mergeOne({ issue: '20', pr: 20, base: 'main', git, checks: fakeGates(calls), merge: merge(calls), cleanup: cleanup(calls) });
  assert.deepEqual(result, { merged: true });
  assert.deepEqual(calls, [
    ['mergeBase', 'main'], ['checks', 'head-0'], ['mergeBase', 'main'], ['merge', 20, 'head-0'], ['cleanup', '20'],
  ]);
});

test('base merge clean: pushes, re-checks the new head, then merges that head', async () => {
  const { git, calls } = fakeGit(['clean', 'up-to-date']);
  const result = await mergeOne({ issue: '20', pr: 20, base: 'main', git, checks: fakeGates(calls), merge: merge(calls), cleanup: cleanup(calls) });
  assert.deepEqual(result, { merged: true });
  assert.deepEqual(calls, [
    ['mergeBase', 'main'], ['push'], ['checks', 'head-1'], ['mergeBase', 'main'], ['merge', 20, 'head-1'], ['cleanup', '20'],
  ]);
});

test('base merge conflict aborts and stops without pushing, checking or merging', async () => {
  const { git, calls } = fakeGit();
  git.mergeBase = async (base) => { calls.push(['mergeBase', base]); return 'conflict'; };
  const result = await mergeOne({ issue: '20', pr: 20, base: 'main', git, checks: fakeGates(calls), merge: merge(calls), cleanup: cleanup(calls) });
  assert.deepEqual(result, { stop: 'conflict' });
  assert.deepEqual(calls, [['mergeBase', 'main'], ['mergeAbort']]);
});

test('failing checks block the merge and the cleanup', async () => {
  const { git, calls } = fakeGit();
  const result = await mergeOne({ issue: '20', pr: 20, base: 'main', git, checks: fakeGates(calls, new Set(['head-0'])), merge: merge(calls), cleanup: cleanup(calls) });
  assert.deepEqual(result, { stop: 'checks-failed' });
  assert.deepEqual(calls, [['mergeBase', 'main'], ['checks', 'head-0']]);
});

test('base moves after gates pass: re-syncs, re-checks the new head, merges only that head', async () => {
  const { git, calls } = fakeGit(['up-to-date', 'clean', 'up-to-date']);
  const result = await mergeOne({ issue: '30', pr: 30, base: 'main', git, checks: fakeGates(calls), merge: merge(calls), cleanup: cleanup(calls) });
  assert.deepEqual(result, { merged: true });
  assert.deepEqual(calls, [
    ['mergeBase', 'main'], ['checks', 'head-0'],
    ['mergeBase', 'main'], ['push'], ['checks', 'head-1'],
    ['mergeBase', 'main'], ['merge', 30, 'head-1'], ['cleanup', '30'],
  ]);
});

test('merge refused when the live head moved: no cleanup', async () => {
  const { git, calls } = fakeGit();
  const result = await mergeOne({ issue: '40', pr: 40, base: 'main', git, checks: fakeGates(calls), merge: merge(calls, false), cleanup: cleanup(calls) });
  assert.deepEqual(result, { stop: 'head-moved' });
  assert.equal(calls.some(c => c[0] === 'cleanup'), false);
});

test('two PRs green on an old base merge one at a time; the second is re-checked after the first merges', async () => {
  // PR 41 sees an up-to-date base; once it merges, main moves, so PR 42 re-syncs (clean) and re-checks its new head.
  const { git, calls } = fakeGit(['up-to-date', 'up-to-date', 'clean', 'up-to-date']);
  const prs = [{ number: 41, body: '' }, { number: 42, body: 'Depends on #41' }];
  const merged = new Set();
  for (let i = 0; i < 2; i++) {
    const next = nextMergeable(prs.filter((pr) => !merged.has(pr.number)), merged);
    const result = await mergeOne({ issue: String(next.number), pr: next.number, base: 'main', git, checks: fakeGates(calls), merge: merge(calls), cleanup: cleanup(calls) });
    assert.deepEqual(result, { merged: true });
    merged.add(next.number);
  }
  assert.deepEqual(calls, [
    ['mergeBase', 'main'], ['checks', 'head-0'], ['mergeBase', 'main'], ['merge', 41, 'head-0'], ['cleanup', '41'],
    ['mergeBase', 'main'], ['push'], ['checks', 'head-1'], ['mergeBase', 'main'], ['merge', 42, 'head-1'], ['cleanup', '42'],
  ]);
});
