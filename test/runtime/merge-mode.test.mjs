import test from 'node:test';
import assert from 'node:assert/strict';
import { createMergeEntryPoint } from '../../runtime/lib/merge.mjs';
import { readMergeConfig } from '../../runtime/lib/merge-mode.mjs';

const gated = { issue: '59', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'], safetyFiles: [], safetyApproved: false };
const evidence = { issue: '59', head: 'abc1234', tree: 'tree-a', highRisk: true, passed: ['gate0', 'gate1', 'gate2', 'ci'], ciGreen: true };
const live = { state: 'open', draft: false, head: 'abc1234', mergeable: true, files: [] };

function fixture({ mode, checks = true, ledger = [] } = {}) {
  const calls = [];
  const store = {
    async load() { return { ledger }; },
    async append(_issue, entry) { ledger.push(entry); },
  };
  const squash = createMergeEntryPoint({
    mode,
    gateState: { async get() { return gated; } },
    store,
    github: {
      async getPullRequest() { return live; },
      async requiredGreen() { calls.push('ci'); return checks; },
      async squashMerge(pr, options) { calls.push(['squash', pr, options.sha]); return { mergeCommit: 'abcdef0123456789' }; },
    },
  });
  return { squash, calls, ledger };
}

const squashes = (calls) => calls.filter((call) => Array.isArray(call)).length;

test('agent mode squashes once and stores the merge record', async () => {
  const f = fixture({ mode: 'agent' });
  const result = await f.squash(90, evidence);
  assert.deepEqual(result, { mergeCommit: 'abcdef0123456789' });
  assert.equal(squashes(f.calls), 1);
  assert.deepEqual(f.ledger.map((entry) => entry.id), ['merge:abc1234']);
});

test('owner mode never squashes, for a normal merge and a revert merge', async () => {
  const f = fixture({ mode: 'owner' });
  assert.deepEqual(await f.squash(90, evidence), { held: 'owner', mode: 'owner' });
  assert.deepEqual(await f.squash(91, { ...evidence, revert: true }), { held: 'owner', mode: 'owner' });
  assert.equal(squashes(f.calls), 0);
  assert.equal(f.ledger.length, 0);
});

test('dry-run mode records one would-merge entry, never squashes, and is idempotent', async () => {
  const f = fixture({ mode: 'dry-run' });
  assert.deepEqual(await f.squash(90, evidence), { held: 'dry-run', mode: 'dry-run' });
  assert.deepEqual(await f.squash(90, evidence), { held: 'dry-run', mode: 'dry-run', replayed: true });
  assert.equal(squashes(f.calls), 0);
  assert.deepEqual(f.ledger, [{ id: 'dry-run:abc1234', type: 'would-merge', detail: { pr: 90 } }]);
});

test('an omitted or unknown mode fails closed to dry-run', async () => {
  const omitted = fixture();
  assert.deepEqual(await omitted.squash(90, evidence), { held: 'dry-run', mode: 'dry-run' });
  const unknown = fixture({ mode: 'always' });
  assert.deepEqual(await unknown.squash(90, evidence), { held: 'dry-run', mode: 'dry-run' });
  assert.equal(squashes(omitted.calls) + squashes(unknown.calls), 0);
});

for (const mode of ['agent', 'owner', 'dry-run']) {
  test(`${mode} mode refuses red or pending required CI and never squashes`, async () => {
    for (const checks of [false, { green: false }]) {
      const f = fixture({ mode, checks });
      await assert.rejects(f.squash(90, evidence), /Required CI is red or pending/);
      assert.equal(squashes(f.calls), 0);
    }
  });
}

test('readMergeConfig resolves the file, malformed, unknown and valid modes', async () => {
  const withFile = (text) => async (path) => {
    assert.match(path, /runtime[\/\\]merge\.config\.json$/);
    if (text instanceof Error) throw text;
    return text;
  };
  assert.equal(await readMergeConfig({ readFile: withFile(new Error('ENOENT')), repoRoot: '/repo' }), 'dry-run');
  assert.equal(await readMergeConfig({ readFile: withFile('{ "mergeMode": '), repoRoot: '/repo' }), 'dry-run');
  assert.equal(await readMergeConfig({ readFile: withFile('{ "mergeMode": "always" }'), repoRoot: '/repo' }), 'dry-run');
  assert.equal(await readMergeConfig({ readFile: withFile('{}'), repoRoot: '/repo' }), 'dry-run');
  for (const mode of ['agent', 'owner', 'dry-run']) {
    assert.equal(await readMergeConfig({ readFile: withFile(JSON.stringify({ mergeMode: mode })), repoRoot: '/repo' }), mode);
  }
});
