import test from 'node:test';
import assert from 'node:assert/strict';
import { runGates } from '../../runtime/lib/gates.mjs';
import { createReviewPrecondition } from '../../runtime/lib/review-precondition.mjs';

const HEAD = 'a'.repeat(40);
const OTHER = 'e'.repeat(40);
const RATIONALE = 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.';

/** Read-only observation clients: `dirty` covers staged, unstaged and untracked changes; `local` is the local HEAD. */
function clients({ local = HEAD, dirty = false } = {}) {
  return { worktree: { async inspect() { return { dirty }; } }, git: { async head() { return local; } } };
}

/** runGates input with a precondition over the given clients; `calls` records every dispatch. */
function gateFixture({ prHead = HEAD, verdict = { passed: true }, ...facts } = {}) {
  const calls = [];
  const records = new Map();
  const ledger = [];
  const github = { async getPullRequest() { return { state: 'open', draft: false, head: prHead, mergeable: true, files: [] }; }, async addLabel() {} };
  const input = {
    issue: '341', head: HEAD, tree: 'tree-a', pr: 9, changedFiles: [],
    precondition: createReviewPrecondition({ clients: clients(facts), issue: '341', github }),
    models: { reviewer: 'model-review' },
    state: { async get(id) { return records.get(id); }, async put(id, value) { records.set(id, structuredClone(value)); } },
    store: { async load() { return { ledger }; }, async append(_id, entry) { ledger.push(entry); } },
    gates: {
      async gate0() { calls.push('gate0'); return { passed: true }; },
      async reviewer(arg) { calls.push('reviewer'); return { ...verdict, head: arg.head, rationale: RATIONALE }; },
    },
    ci: { async requiredGreen() { calls.push('ci'); return { green: true }; } },
    merge: { async squash() { calls.push('merge'); return { merged: true }; } },
    github,
  };
  return { input, calls, records };
}

test('a worktree with staged, unstaged or untracked changes is held before the reviewer is dispatched', async () => {
  const f = gateFixture({ dirty: true });
  const result = await runGates(f.input);
  assert.deepEqual([result.status, result.gate, result.reason, result.hold], ['blocked', 'gate1', 'review_precondition', true]);
  assert.equal(f.calls.includes('reviewer'), false);
  assert.equal(f.records.get('341')?.passed.includes('gate1') ?? false, false);
});

test('a worktree whose cleanliness is unknown is held, never assumed clean', async () => {
  const f = gateFixture();
  f.input.precondition = createReviewPrecondition({ clients: { worktree: { async inspect() { return {}; } }, git: { async head() { return HEAD; } } }, issue: '341', github: { async getPullRequest() { return { head: HEAD }; } } });
  const result = await runGates(f.input);
  assert.deepEqual([result.reason, result.hold], ['review_precondition', true]);
  assert.equal(f.calls.includes('reviewer'), false);
});

test('a clean worktree whose local HEAD is not the pushed PR head is held before dispatch', async () => {
  const f = gateFixture({ local: OTHER });
  const result = await runGates(f.input);
  assert.deepEqual([result.status, result.reason, result.hold], ['blocked', 'review_precondition', true]);
  assert.equal(f.calls.includes('reviewer'), false);
});

test('a clean worktree at the pushed PR head dispatches the reviewer and passes Gate 1', async () => {
  const f = gateFixture();
  const result = await runGates(f.input);
  assert.equal(result.status, 'merged');
  assert.ok(f.calls.includes('reviewer'));
});

test('a reviewer verdict for a different head never counts as a pass nor is recorded for this head', async () => {
  for (const verdict of [{ passed: true }, { passed: false, status: 'reject', reason: 'bad' }]) {
    const f = gateFixture({ verdict });
    f.input.gates.reviewer = async () => ({ ...verdict, head: OTHER, rationale: RATIONALE });
    const result = await runGates(f.input);
    assert.equal(result.status, 'blocked');
    assert.equal(result.hold, false);
    assert.equal(f.calls.includes('merge'), false);
    assert.equal(f.records.get('341')?.passed.includes('gate1') ?? false, false);
  }
});
