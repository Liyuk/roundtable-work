import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runGates, recoverRedMain } from '../../runtime/lib/gates.mjs';
import { createMergeEntryPoint } from '../../runtime/lib/merge.mjs';

function fixture(overrides = {}) {
  const calls = [];
  const records = new Map();
  const input = {
    issue: '53', head: 'abc1234', tree: 'tree-a', highRisk: true,
    changedFiles: ['runtime/lib/gates.mjs'], pr: 90,
    models: { reviewer: 'model-review-strong', crossCheck: 'model-crosscheck' },
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

function gatedRecord(overrides = {}) {
  return { issue: '53', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'], safetyFiles: [], safetyApproved: false, ...overrides };
}

function livePullRequest(files) {
  return { state: 'open', draft: false, head: 'abc1234', mergeable: true, ...(files === undefined ? {} : { files }) };
}

function entryFixture({ persisted = gatedRecord(), live = livePullRequest([]) } = {}) {
  const calls = [];
  const entry = createMergeEntryPoint({
    gateState: { async get() { return persisted; } },
    github: {
      async getPullRequest() { calls.push('pr'); return live; },
      async requiredGreen() { calls.push('ci'); return true; },
      async squashMerge(_pr, options) { calls.push(['merge', options]); return 'merged'; },
    },
  });
  const evidence = { issue: '53', head: 'abc1234', tree: 'tree-a', highRisk: true, passed: ['gate0', 'gate1', 'gate2', 'ci'], ciGreen: true };
  return { entry, calls, evidence };
}

test('runs deterministic gates, CI, then single squash entry point without a human actor', async () => {
  const f = fixture();
  const result = await runGates(f.input);
  assert.equal(result.status, 'merged');
  assert.deepEqual(f.calls.filter((x) => ['gate0', 'reviewer:1', 'gate2', 'ci', 'merge'].includes(x)), ['gate0', 'reviewer:1', 'gate2', 'ci', 'merge']);
  assert.equal(f.calls.filter((x) => x === 'merge').length, 1);
});

test('review and cross-check gates use their configured work-type routes', async () => {
  const f = fixture({ models: {}, modelRouter: type => ({ review: 'review-config', 'cross-check': 'audit-config' })[type] });
  let reviewModel; let crossCheckModel;
  f.input.gates = {
    async gate0() { return true; },
    async reviewer(args) { reviewModel = args.model; return { passed: true, head: args.head }; },
    async crossCheck(args) { crossCheckModel = args.model; return true; },
  };
  await runGates(f.input);
  assert.equal(reviewModel, 'review-config');
  assert.equal(crossCheckModel, 'audit-config');
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
    gateState: { async get() { return { issue: '53', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'], safetyFiles: [], safetyApproved: false }; } },
    github: {
      async getPullRequest() { calls.push('pr'); return { state: 'open', draft: false, head: 'abc1234', mergeable: true, files: [] }; },
      async requiredGreen() { calls.push('ci'); return true; },
      async squashMerge(_pr, options) { calls.push(['merge', options]); return 'merged'; },
    },
  });
  assert.equal(await entry(90, { issue: '53', head: 'abc1234', tree: 'tree-a', highRisk: true, passed: ['gate0', 'gate1', 'gate2', 'ci'], ciGreen: true, safetyApproved: false }), 'merged');
  assert.deepEqual(calls, ['pr', 'ci', ['merge', { method: 'squash', sha: 'abc1234' }]]);
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

test('single merge entry point rejects a live safety file that was not in the gated set', async () => {
  // Bypass regression: the provider returns no safetyFiles/safetyApprovalHead, yet the live diff shows
  // a safety file the gate never approved.
  const f = entryFixture({ live: livePullRequest(['.github/workflows/check.yml']) });
  await assert.rejects(f.entry(90, f.evidence), /Safety-file set changed/);
  assert.deepEqual(f.calls, ['pr']);
  assert.equal(f.calls.some(Array.isArray), false);
});

test('single merge entry point rejects live safety files added or removed since gating', async () => {
  const added = entryFixture({
    persisted: gatedRecord({ safetyFiles: ['.github/workflows/check.yml'], safetyApproved: true }),
    live: livePullRequest(['.github/workflows/check.yml', 'scripts/check.mjs']),
  });
  await assert.rejects(added.entry(90, added.evidence), /Safety-file set changed/);
  assert.deepEqual(added.calls, ['pr']);
  const removed = entryFixture({
    persisted: gatedRecord({ safetyFiles: ['.github/workflows/check.yml', 'scripts/check.mjs'], safetyApproved: true }),
    live: livePullRequest(['.github/workflows/check.yml']),
  });
  await assert.rejects(removed.entry(90, removed.evidence), /Safety-file set changed/);
  assert.deepEqual(removed.calls, ['pr']);
});

test('single merge entry point fails closed when live changed files are missing', async () => {
  const missing = entryFixture({ live: livePullRequest(undefined) });
  await assert.rejects(missing.entry(90, missing.evidence), /Live pull request changed files are required/);
  assert.deepEqual(missing.calls, ['pr']);
  const malformed = entryFixture({ live: livePullRequest([42]) });
  await assert.rejects(malformed.entry(90, malformed.evidence), /Live pull request changed files are required/);
  assert.deepEqual(malformed.calls, ['pr']);
});

test('single merge entry point fails closed without a gated safety-file list', async () => {
  const withoutList = entryFixture({ persisted: { ...gatedRecord(), safetyFiles: undefined } });
  await assert.rejects(withoutList.entry(90, withoutList.evidence), /Gated safety-file list is missing/);
  assert.deepEqual(withoutList.calls, ['pr']);
});

test('single merge entry point requires recorded approval for a non-empty live safety set', async () => {
  const stale = entryFixture({
    persisted: gatedRecord({ safetyFiles: ['.github/workflows/check.yml'], safetyApproved: false }),
    live: livePullRequest(['.github/workflows/check.yml']),
  });
  await assert.rejects(stale.entry(90, stale.evidence), /Safety-file approval is missing or stale/);
  assert.deepEqual(stale.calls, ['pr']);
});

test('approved safety-file set merges without provider safety fields', async () => {
  const f = entryFixture({
    persisted: gatedRecord({ safetyFiles: ['.github/workflows/check.yml'], safetyApproved: true }),
    live: livePullRequest(['.github/workflows/check.yml', 'runtime/lib/gates.mjs']),
  });
  assert.equal(await f.entry(90, f.evidence), 'merged');
  assert.deepEqual(f.calls, ['pr', 'ci', ['merge', { method: 'squash', sha: 'abc1234' }]]);
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

test('only pending required CI is a resumable hold; every other not-green answer fails closed before squash', async () => {
  const cases = [
    ['pending', { green: false, status: 'pending' }, true],
    ['false', false, false],
    ['failure', { green: false, status: 'failure' }, false],
    ['red', { green: false, status: 'red' }, false],
    ['no status', { green: false }, false],
  ];
  for (const [name, checks, hold] of cases) {
    const f = fixture({ ci: { async requiredGreen() { return checks; } } });
    const result = await runGates(f.input);
    assert.deepEqual([result.status, result.gate, result.hold], ['blocked', 'ci', hold], name);
    assert.equal(f.calls.includes('merge'), false, name);
  }
});

test('cancelled-only required CI requests one re-run and holds instead of failing into the fixer path', async () => {
  let reruns = 0;
  const f = fixture({ ci: { async requiredGreen() { return { green: false, status: 'cancelled' }; }, async rerunCancelled(pr) { reruns++; assert.equal(pr, 90); } } });
  const result = await runGates(f.input);
  assert.deepEqual([result.status, result.gate, result.hold], ['blocked', 'ci', true]);
  assert.equal(reruns, 1);
  assert.equal(f.calls.includes('merge'), false);
  assert.equal(f.records.get('53').ciReruns, 1);
});

test('cancelled CI with a re-run capability is a hold and never a retryable fixer finding', async () => {
  const f = fixture({ ci: { async requiredGreen() { return { green: false, status: 'cancelled' }; }, async rerunCancelled() {} } });
  const result = await runGates(f.input);
  assert.deepEqual([result.status, result.gate, result.hold], ['blocked', 'ci', true]);
  assert.equal(result.retryable, undefined);
  assert.equal(result.retryFinding, undefined);
});

test('a real CI failure never requests a re-run and stays fail-closed', async () => {
  let reruns = 0;
  const f = fixture({ ci: { async requiredGreen() { return { green: false, status: 'failure' }; }, async rerunCancelled() { reruns++; } } });
  const result = await runGates(f.input);
  assert.deepEqual([result.status, result.gate, result.hold], ['blocked', 'ci', false]);
  assert.equal(reruns, 0);
  assert.equal(f.calls.includes('merge'), false);
});

test('a cancelled CI after two re-runs falls back to the fail-closed path without a third request', async () => {
  let reruns = 0;
  const f = fixture({ ci: { async requiredGreen() { f.calls.push('ci'); return { green: false, status: 'cancelled' }; }, async rerunCancelled() { reruns++; } } });
  f.records.set('53', gatedRecord({ ciReruns: 2 }));
  const result = await runGates(f.input);
  assert.equal(result.hold, false);
  assert.equal(reruns, 0);
  assert.ok(f.calls.includes('ci'));
  assert.equal(f.calls.includes('merge'), false);
  assert.equal(f.records.get('53').ciReruns, 2);
});

test('a provider without a re-run capability keeps the cancelled-CI behaviour of today', async () => {
  const f = fixture({ ci: { async requiredGreen() { return { green: false, status: 'cancelled' }; } } });
  const result = await runGates(f.input);
  assert.deepEqual([result.status, result.gate, result.hold], ['blocked', 'ci', false]);
  assert.equal(f.calls.includes('merge'), false);
});

test('safety-file diff requires recorded escalation-model approval for current head', async () => {
  const f = fixture({ changedFiles: ['.github/workflows/check.yml'] });
  const result = await runGates(f.input);
  assert.equal(result.gate, 'safety-approval');
  assert.ok(f.calls.includes('label:rt:ready-to-merge'));
  assert.equal(f.calls.includes('merge'), false);
});

test('cross-check model approval cannot authorize a safety-file merge', async () => {
  const f = fixture({ changedFiles: ['.github/workflows/check.yml'], models: {},
    modelRouter: type => ({ review: 'review-model', escalation: 'escalation-model', 'cross-check': 'cross-check-model' })[type],
    github: { async recordedEscalationApproval() { return { approved: true, model: 'cross-check-model', head: 'abc1234' }; }, async addLabel() {} },
  });
  assert.equal((await runGates(f.input)).gate, 'safety-approval');
  assert.equal(f.calls.includes('merge'), false);
});

test('approved safety-file change records approval at gate time and merges through the entry point', async () => {
  const files = ['.github/workflows/check.yml', 'runtime/lib/gates.mjs'];
  const f = fixture({
    changedFiles: files,
    github: {
      async recordedEscalationApproval() { f.calls.push('approval'); return { approved: true, model: 'model-crosscheck', head: 'abc1234' }; },
      async addLabel(_pr, label) { f.calls.push(`label:${label}`); },
    },
  });
  assert.equal((await runGates(f.input)).status, 'merged');
  const persisted = f.records.get('53');
  assert.deepEqual(persisted.safetyFiles, ['.github/workflows/check.yml']);
  assert.equal(persisted.safetyApproved, true);
  // The provider supplies only live changed files, no safetyFiles/safetyApprovalHead hint fields.
  const entry = createMergeEntryPoint({
    gateState: { async get() { return persisted; } },
    github: {
      async getPullRequest() { return { state: 'open', draft: false, head: 'abc1234', mergeable: true, files }; },
      async requiredGreen() { return true; },
      async squashMerge(_pr, options) { return { merged: options }; },
    },
  });
  assert.deepEqual(await entry(90, { issue: '53', head: 'abc1234', tree: 'tree-a', highRisk: true, passed: ['gate0', 'gate1', 'gate2', 'ci'], ciGreen: true }), { merged: { method: 'squash', sha: 'abc1234' } });
});

test('runGates passes the routed reviewer and cross-check models to the gates', async () => {
  const seen = {};
  const f = fixture({
    gates: {
      async gate0() { return true; },
      async reviewer(arg) { seen.reviewer = arg.model; return { passed: true, head: 'abc1234' }; },
      async crossCheck(arg) { seen.crossCheck = arg.model; return true; },
    },
  });
  assert.equal((await runGates(f.input)).status, 'merged');
  assert.deepEqual(seen, { reviewer: 'model-review-strong', crossCheck: 'model-crosscheck' });
});

test('a high-risk diff without a configured cross-check model fails closed, not as a hold', async () => {
  const f = fixture({ models: {} });
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.gate, 'gate2');
  assert.equal(result.hold, false);
  assert.match(result.reason, /cross-check model/);
  assert.equal(f.calls.includes('merge'), false);
});

test('a safety-file change without a configured cross-check model is a clear hold', async () => {
  const f = fixture({ highRisk: false, changedFiles: ['.github/workflows/check.yml'], models: {} });
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.gate, 'safety-approval');
  assert.equal(result.hold, true);
  assert.match(result.reason, /cross-check model/);
  assert.equal(f.calls.includes('merge'), false);
});

test('the safety approval must name the routed cross-check model', async () => {
  const f = fixture({
    changedFiles: ['.github/workflows/check.yml'],
    github: {
      async recordedEscalationApproval() { f.calls.push('approval'); return { approved: true, model: 'model-other', head: 'abc1234' }; },
      async addLabel(_pr, label) { f.calls.push(`label:${label}`); },
    },
  });
  const result = await runGates(f.input);
  assert.equal(result.gate, 'safety-approval');
  assert.equal(result.hold, true);
  assert.equal(f.calls.includes('merge'), false);
});

test('gates source contains no hard-coded model literal', async () => {
  const source = await readFile(new URL('../../runtime/lib/gates.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /model:\s*'/);
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

test('green main at the merge commit is a no-action with no pause or git/github side effects', async () => {
  const calls = [];
  const trap = (name) => async () => { calls.push(name); };
  const result = await recoverRedMain({ mergeCommit: 'abcdef0123456789', mainHead: 'abcdef0123456789', mainRed: false,
    pause: { claimsAndMerges: trap('pause') },
    git: { createRevert: trap('revert') },
    github: { openRevertPullRequest: trap('pr'), createIssue: trap('issue'), requiredGreen: trap('revert-ci') },
    merge: { squash: trap('merge') },
  });
  assert.deepEqual(result, { status: 'no-action' });
  assert.deepEqual(calls, []);
});

test('red main with a not-green revert CI pauses before revert and does not merge the revert', async () => {
  const calls = [];
  const result = await recoverRedMain({ mergeCommit: 'abcdef0123456789', mainHead: 'abcdef0123456789', mainRed: true,
    pause: { async claimsAndMerges(v) { calls.push(['pause', v]); } },
    git: { async createRevert(v) { calls.push(['revert', v.branch]); return {}; } },
    github: {
      async openRevertPullRequest() { calls.push(['pr']); return { number: 91, head: 'reverthead' }; },
      async createIssue() { calls.push(['issue']); },
      async requiredGreen(pr) { calls.push(['revert-ci', pr]); return { green: false }; },
    },
    merge: { async squash() { calls.push(['merge']); } },
  });
  assert.deepEqual(result, { status: 'revert-pending', paused: true, pr: 91, branch: 'rt/revert-abcdef0' });
  assert.deepEqual(calls[0], ['pause', { paused: true, reason: 'main is red after auto-merge' }]);
  assert.equal(calls.some(([name]) => name === 'merge'), false);
});
