import test from 'node:test';
import assert from 'node:assert/strict';
import { findBreakingCommit } from '../../runtime/lib/red-main.mjs';
import { recoverRedMain } from '../../runtime/lib/gates.mjs';

test('the breaking commit is the oldest red after the last green (newest-first history)', () => {
  const history = [{ sha: 'aaa1111', state: 'red' }, { sha: 'bbb2222', state: 'red' }, { sha: 'ccc3333', state: 'green' }];
  assert.equal(findBreakingCommit(history), 'bbb2222');
});

test('pending commits are skipped, neither red nor green', () => {
  const history = [{ sha: 'aaa1111', state: 'red' }, { sha: 'bbb2222', state: 'pending' }, { sha: 'ccc3333', state: 'red' }, { sha: 'ddd4444', state: 'green' }];
  assert.equal(findBreakingCommit(history), 'ccc3333');
});

test('no red commit after the last green gives null', () => {
  assert.equal(findBreakingCommit([{ sha: 'aaa1111', state: 'green' }, { sha: 'bbb2222', state: 'red' }]), null);
});

test('history with no green commit cannot prove the breaking commit and gives null', () => {
  assert.equal(findBreakingCommit([{ sha: 'aaa1111', state: 'red' }, { sha: 'bbb2222', state: 'red' }]), null);
});

const redDeps = (over = {}) => {
  const calls = [];
  const deps = {
    pause: { async claimsAndMerges() {} },
    git: {
      async revertPlan() { calls.push(['plan']); return { deleted: [], files: new Map() }; },
      async createRevert(v) { calls.push(['revert', v.mergeCommit, v.branch]); return { sha: 'revertsha' }; },
    },
    github: {
      async openRevertPullRequest(v) { calls.push(['pr', v.branch, v.body]); return { number: 91, head: 'reverthead' }; },
      async requiredGreen() { return { green: true }; },
      async createIssue(v) { calls.push(['issue', v.labels, v.body]); return { number: 5 }; },
    },
    merge: { async squash(pr) { calls.push(['merge', pr]); } },
    ...over,
  };
  return { deps, calls };
};

test('red main after a green run reverts the breaking commit, not the merge commit, and names it in the PR body', async () => {
  const { deps, calls } = redDeps();
  const history = [{ sha: 'fff9999', state: 'red' }, { sha: 'eee8888', state: 'red' }, { sha: 'ddd7777', state: 'green' }];
  const result = await recoverRedMain({ mergeCommit: 'fff9999aaaa', mainHead: 'fff9999aaaa', mainRed: true, history, ...deps });
  assert.equal(result.status, 'reverted');
  assert.deepEqual(calls.filter(([name]) => name === 'revert'), [['revert', 'eee8888', 'rt/revert-eee8888']]);
  assert.equal(calls.find(([name]) => name === 'issue')[2].includes('eee8888'), true);
  assert.equal(calls.find(([name]) => name === 'pr')[2].includes('eee8888'), true);
});

test('without main history the merge commit at main head is reverted as before', async () => {
  const { deps, calls } = redDeps();
  await recoverRedMain({ mergeCommit: 'fff9999aaaa', mainHead: 'fff9999aaaa', mainRed: true, ...deps });
  assert.deepEqual(calls.filter(([name]) => name === 'revert'), [['revert', 'fff9999aaaa', 'rt/revert-fff9999']]);
});

test('the investigate issue carries priority:p0 with type:bug and rt:self', async () => {
  const { deps, calls } = redDeps();
  await recoverRedMain({ mergeCommit: 'fff9999aaaa', mainHead: 'fff9999aaaa', mainRed: true, ...deps });
  assert.deepEqual(calls.find(([name]) => name === 'issue')[1], ['type:bug', 'rt:self', 'priority:p0']);
});

test('a revert that would leave dangling references is refused: no revert, no PR, blocker recorded in the issue', async () => {
  const calls = [];
  const { deps } = redDeps({
    git: {
      async revertPlan(v) {
        calls.push(['plan', v.mergeCommit]);
        return { deleted: ['runtime/lib/new.mjs'], files: new Map([['runtime/rtd.mjs', "import { x } from './lib/new.mjs';\n"]]) };
      },
      async createRevert() { calls.push(['revert']); },
    },
    github: {
      async openRevertPullRequest() { calls.push(['pr']); },
      async requiredGreen() { calls.push(['ci']); },
      async createIssue(v) { calls.push(['issue', v.labels, v.body]); return { number: 6 }; },
    },
  });
  const history = [{ sha: 'fff9999', state: 'red' }, { sha: 'ddd7777', state: 'green' }];
  const result = await recoverRedMain({ mergeCommit: 'fff9999aaaa', mainHead: 'fff9999aaaa', mainRed: true, history, ...deps });
  assert.equal(result.status, 'blocked-dangling');
  assert.equal(result.paused, true);
  assert.deepEqual(calls.map(([name]) => name), ['plan', 'issue']);
  assert.deepEqual(calls[1][1], ['type:bug', 'rt:self', 'priority:p0']);
  assert.match(calls[1][2], /runtime\/rtd\.mjs imports \.\/lib\/new\.mjs/);
});
