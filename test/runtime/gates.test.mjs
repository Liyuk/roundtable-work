import test from 'node:test';
import assert from 'node:assert/strict';
import { runGates, recoverRedMain } from '../../runtime/lib/gates.mjs';
import { createMergeEntryPoint } from '../../runtime/lib/merge.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const records = new Map();
  const input = {
    issue: '53', head: 'abc1234', tree: 'tree-a', highRisk: true,
    changedFiles: ['runtime/lib/gates.mjs'], pr: 90,
    state: { async get(id) { calls.push('state:get'); return records.get(id); }, async put(id, value) { calls.push(`state:put:${value.passed.at(-1)}`); records.set(id, structuredClone(value)); } },
    gates: {
      async gate0() { calls.push('gate0'); return { passed: true }; },
      async reviewer(arg) { calls.push(`reviewer:${arg.attempt}`); return { passed: true, head: 'abc1234' }; },
      async crossCheck() { calls.push('gate2'); return { passed: true }; },
    },
    ci: { async requiredGreen() { calls.push('ci'); return { green: true }; } },
    merge: { async squash(pr, evidence) { calls.push('merge'); assert.equal(pr, 90); assert.equal(evidence.ciGreen, true); return { merged: true }; } },
    github: {
      async recordedEscalationApproval() { calls.push('approval'); return null; },
      async addLabel(_pr, label) { calls.push(`label:${label}`); },
    },
  };
  return { input: { ...input, ...overrides }, calls, records };
}

test('runs deterministic gates, CI, then single squash entry point without a human actor', async () => {
  const f = fixture();
  const result = await runGates(f.input);
  assert.equal(result.status, 'merged');
  assert.deepEqual(f.calls.filter((x) => ['gate0', 'reviewer:1', 'gate2', 'ci', 'merge'].includes(x)), ['gate0', 'reviewer:1', 'gate2', 'ci', 'merge']);
  assert.equal(f.calls.filter((x) => x === 'merge').length, 1);
});

test('gate failure blocks subsequent gates and merge', async () => {
  const f = fixture({ gates: { ...fixture().input.gates, async gate0() { f.calls.push('gate0'); return { passed: false }; } } });
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(f.calls.includes('merge'), false);
  assert.equal(f.calls.includes('reviewer:1'), false);
});

test('reviewer unavailable is retried once, then only ready-to-merge is labeled', async () => {
  let attempts = 0;
  const f = fixture({ gates: {
    async gate0() { return true; },
    async reviewer() { attempts++; const e = new Error('offline'); e.code = 'REVIEWER_UNAVAILABLE'; throw e; },
  } });
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(f.calls.filter((x) => x.startsWith('label:')).join(), 'label:rt:ready-to-merge');
  assert.equal(attempts, 2);
  assert.equal(f.calls.includes('merge'), false);
});

test('single merge entry point rechecks persisted gates, live head, mergeability, and CI', async () => {
  const calls = [];
  const entry = createMergeEntryPoint({
    gateState: { async get() { return { issue: '53', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'] }; } },
    github: {
      async getPullRequest() { calls.push('pr'); return { state: 'open', draft: false, head: 'abc1234', mergeable: true }; },
      async requiredGreen() { calls.push('ci'); return true; },
      async squashMerge(_pr, options) { calls.push(['merge', options]); return 'merged'; },
    },
  });
  assert.equal(await entry(90, { issue: '53', head: 'abc1234', tree: 'tree-a', highRisk: true, passed: ['gate0', 'gate1', 'gate2', 'ci'], ciGreen: true, safetyApproved: false }), 'merged');
  assert.deepEqual(calls, ['pr', 'ci', ['merge', { method: 'squash' }]]);
});

test('single merge entry point refuses stale heads and red CI without invoking merge', async () => {
  let merges = 0;
  const entry = createMergeEntryPoint({
    gateState: { async get() { return { issue: '53', head: 'oldhead', tree: 'tree-a', passed: ['gate0', 'gate1', 'ci'] }; } },
    github: {
      async getPullRequest() { return { state: 'open', draft: false, head: 'abc1234', mergeable: true }; },
      async requiredGreen() { return false; }, async squashMerge() { merges++; },
    },
  });
  await assert.rejects(entry(90, { issue: '53', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'ci'], ciGreen: true }), /stale/);
  assert.equal(merges, 0);
});

test('persisted gates resume for same head/tree and stale head invalidates every gate', async () => {
  const f = fixture();
  await runGates(f.input);
  f.calls.length = 0;
  await runGates({ ...f.input, highRisk: true });
  assert.equal(f.calls.includes('gate0'), false);
  f.calls.length = 0;
  await runGates({ ...f.input, head: 'def5678', tree: 'tree-b' });
  assert.ok(f.calls.indexOf('gate0') >= 0);
  assert.ok(f.calls.indexOf('gate0') < f.calls.indexOf('reviewer:1'));
});

test('red or pending CI never reaches squash merge', async () => {
  const f = fixture({ ci: { async requiredGreen() { return { green: false, status: 'pending' }; } } });
  assert.equal((await runGates(f.input)).gate, 'ci');
  assert.equal(f.calls.includes('merge'), false);
});

test('safety-file diff requires recorded escalation-model approval for current head', async () => {
  const f = fixture({ changedFiles: ['.github/workflows/check.yml'] });
  const result = await runGates(f.input);
  assert.equal(result.gate, 'safety-approval');
  assert.ok(f.calls.includes('label:rt:ready-to-merge'));
  assert.equal(f.calls.includes('merge'), false);
});

test('red-main recovery pauses claims and merges, opens revert PR, and files bug issue', async () => {
  const calls = [];
  const result = await recoverRedMain({ mergeCommit: 'abcdef0123456789', mainHead: 'abcdef0123456789', mainRed: true,
    pause: { async claimsAndMerges(v) { calls.push(['pause', v.paused]); } },
    git: { async createRevert(v) { calls.push(['revert', v.branch]); return { sha: 'revertsha' }; } },
    github: {
      async openRevertPullRequest(v) { calls.push(['pr', v.branch]); return { number: 91, head: 'reverthead' }; },
      async requiredGreen(pr) { calls.push(['revert-ci', pr]); return { green: true }; },
      async createIssue(v) { calls.push(['issue', ...v.labels]); },
    },
    merge: { async squash(pr, evidence) { calls.push(['merge-revert', pr, evidence.revert]); } },
  });
  assert.equal(result.status, 'reverted');
  assert.deepEqual(calls, [['pause', true], ['revert', 'rt/revert-abcdef0'], ['pr', 'rt/revert-abcdef0'], ['issue', 'type:bug', 'rt:self'], ['revert-ci', 91], ['merge-revert', 91, true]]);
});

test('no red main or unrelated main head does not cause recovery side effects', async () => {
  let invoked = false;
  const deps = { pause: { async claimsAndMerges() { invoked = true; } }, git: { async createRevert() { invoked = true; } }, github: {} };
  assert.equal((await recoverRedMain({ mergeCommit: 'abcdef0123456789', mainHead: 'other123', mainRed: true, ...deps })).status, 'no-action');
  assert.equal(invoked, false);
});
