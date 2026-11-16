import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrRecord, validatePrRecord, extractPrRecord, upsertPrRecord } from '../../runtime/lib/pr-record.mjs';
import { createMergeEntryPoint } from '../../runtime/lib/merge.mjs';

const HEAD = 'abc1234';
const TREE = 'tree-a';
const ALL = ['gate0', 'gate1', 'gate2', 'ci'];
const REQUIRED = ['gate0', 'gate1', 'gate2', 'ci'];

function completeRecord(overrides = {}) {
  return buildPrRecord({ issue: '340', head: HEAD, tree: TREE, passed: ALL, ...overrides });
}

test('a complete fixture builds a record that validates against head and required gates', () => {
  const record = completeRecord({ usage: { inputTokens: 10, outputTokens: 4, calls: 2 } });
  assert.deepEqual(record.verdicts, [{ gate: 'gate1', role: null, verdict: '审查结论：通过', sha: HEAD }]);
  assert.deepEqual(record.checks.map((check) => check.name), REQUIRED);
  assert.deepEqual(record.usage, { usageKnown: true, inputTokens: 10, outputTokens: 4, calls: 2 });
  assert.deepEqual(record.rounds[0], { gate: 'gate0', role: null, harness: null, model: null, degraded: false, chiefImplemented: false });
  assert.deepEqual(validatePrRecord(record, { head: HEAD, tree: TREE, requiredGates: REQUIRED }), { ok: true });
});

test('validation rejects a verdict sha that differs from head', () => {
  const record = completeRecord();
  record.verdicts[0].sha = 'old5678';
  assert.equal(validatePrRecord(record, { head: HEAD, tree: TREE, requiredGates: REQUIRED }).ok, false);
  assert.match(validatePrRecord(record, { head: HEAD, tree: TREE, requiredGates: REQUIRED }).reason, /verdict sha/);
});

test('validation rejects a missing required check and a check whose sha differs from head', () => {
  const missing = completeRecord({ passed: ['gate0', 'gate1', 'ci'] });
  assert.match(validatePrRecord(missing, { head: HEAD, tree: TREE, requiredGates: REQUIRED }).reason, /gate2/);
  const stale = completeRecord();
  stale.checks[0].sha = 'old5678';
  assert.match(validatePrRecord(stale, { head: HEAD, tree: TREE, requiredGates: REQUIRED }).reason, /check sha/);
});

test('validation never throws on malformed data', () => {
  assert.equal(validatePrRecord(null, { head: HEAD, tree: TREE, requiredGates: REQUIRED }).ok, false);
  assert.equal(validatePrRecord({ ...completeRecord(), checks: 'nope' }, { head: HEAD, tree: TREE, requiredGates: REQUIRED }).ok, false);
});

test('extract returns the parsed block and null when it is absent or unparseable', () => {
  const record = completeRecord();
  assert.deepEqual(extractPrRecord(`intro\n\n${upsertPrRecord('', record)}`), record);
  assert.equal(extractPrRecord('no block here'), null);
  assert.equal(extractPrRecord('```rt-record\n{not json\n```'), null);
});

test('upsert replaces an existing block and never leaves two blocks', () => {
  const first = upsertPrRecord('Summary\n', completeRecord());
  const replaced = upsertPrRecord(first, completeRecord({ passed: ALL, usage: { inputTokens: 1, outputTokens: 2, calls: 3 } }));
  assert.equal(replaced.match(/```rt-record/g).length, 1);
  assert.deepEqual(extractPrRecord(replaced).usage, { usageKnown: true, inputTokens: 1, outputTokens: 2, calls: 3 });
  assert.equal(upsertPrRecord(replaced, completeRecord()).match(/```rt-record/g).length, 1);
});

const pr = { state: 'open', draft: false, head: HEAD, mergeable: true, files: [] };
const evidence = { issue: '340', head: HEAD, tree: TREE, highRisk: true, passed: ALL, ciGreen: true };

function mergeFixture({ persisted = { issue: '340', head: HEAD, tree: TREE, passed: ALL, safetyFiles: [], safetyApproved: false }, body } = {}) {
  const squashes = [];
  const github = {
    async getPullRequest() { return body === undefined ? pr : { ...pr, body }; },
    async requiredGreen() { return true; },
    async squashMerge(number) { squashes.push(number); return 'merged'; },
  };
  return { squashes, entry: createMergeEntryPoint({ mode: 'agent', gateState: { async get() { return persisted; } }, github }) };
}

test('merge refuses an invalid record before squashMerge', async () => {
  const { squashes, entry } = mergeFixture();
  await assert.rejects(entry(340, { ...evidence, usage: { inputTokens: 1 } }), /PR record is invalid: usage is malformed/);
  assert.deepEqual(squashes, []);
});

test('merge refuses when the live pull request body carries no record block', async () => {
  const { squashes, entry } = mergeFixture({ body: 'no record here' });
  await assert.rejects(entry(340, evidence), /PR record is missing or stale/);
  assert.deepEqual(squashes, []);
});

test('merge succeeds when the body carries the matching record block', async () => {
  const record = buildPrRecord({ issue: '340', head: HEAD, tree: TREE, passed: ALL });
  const { squashes, entry } = mergeFixture({ body: upsertPrRecord('Body', record) });
  assert.equal(await entry(340, evidence), 'merged');
  assert.deepEqual(squashes, [340]);
});

test('merge refuses when the body record carries an old verdict sha', async () => {
  const record = structuredClone(buildPrRecord({ issue: '340', head: HEAD, tree: TREE, passed: ALL }));
  record.verdicts[0].sha = 'old5678';
  const { squashes, entry } = mergeFixture({ body: upsertPrRecord('Body', record) });
  await assert.rejects(entry(340, evidence), /PR record is missing or stale/);
  assert.deepEqual(squashes, []);
});

test('merge refuses when the body record lacks a required check', async () => {
  const record = structuredClone(buildPrRecord({ issue: '340', head: HEAD, tree: TREE, passed: ALL }));
  record.checks = record.checks.filter((check) => check.name !== 'gate2');
  const { squashes, entry } = mergeFixture({ body: upsertPrRecord('Body', record) });
  await assert.rejects(entry(340, evidence), /PR record is missing or stale/);
  assert.deepEqual(squashes, []);
});

test('merge refuses before squashMerge when the live body is not supplied', async () => {
  const { squashes, entry } = mergeFixture();
  await assert.rejects(entry(340, evidence), /PR record check failed: pull request body not supplied/);
  assert.deepEqual(squashes, []);
});

test('a production-shaped pull request result with a matching body record squashes', async () => {
  const body = upsertPrRecord('Body', buildPrRecord({ issue: '340', head: HEAD, tree: TREE, passed: ALL }));
  const squashes = [];
  const github = {
    async getPullRequest() { return { state: 'open', draft: false, head: HEAD, mergeable: true, files: [], body }; },
    async requiredGreen() { return true; },
    async squashMerge(number) { squashes.push(number); return 'merged'; },
  };
  const entry = createMergeEntryPoint({ mode: 'agent', gateState: { async get() { return { issue: '340', head: HEAD, tree: TREE, passed: ALL, safetyFiles: [], safetyApproved: false }; } }, github });
  assert.equal(await entry(340, evidence), 'merged');
  assert.deepEqual(squashes, [340]);
});

function bodyWriteFixture({ body = 'Body', persist = true, fail } = {}) {
  const calls = [];
  const state = { body };
  const github = {
    async getPullRequest() { return pr; },
    async requiredGreen() { return true; },
    async squashMerge(number) { calls.push(`squash:${number}`); return 'merged'; },
  };
  const pullRequestBody = {
    async read() { return state.body; },
    async write(number, text) {
      calls.push(`write:${number}`);
      if (fail) throw fail;
      if (persist) state.body = text;
    },
  };
  const persisted = { issue: '340', head: HEAD, tree: TREE, passed: ALL, safetyFiles: [], safetyApproved: false };
  const entry = createMergeEntryPoint({ mode: 'agent', gateState: { async get() { return persisted; } }, github, pullRequestBody });
  return { calls, state, entry };
}

const currentRecord = () => buildPrRecord({ issue: '340', head: HEAD, tree: TREE, passed: ALL });

test('merge writes the record block into the body before squashing and merges', async () => {
  const { calls, state, entry } = bodyWriteFixture({ body: 'Summary' });
  assert.equal(await entry(340, evidence), 'merged');
  assert.deepEqual(calls, ['write:340', 'squash:340']);
  assert.equal(state.body.match(/```rt-record/g).length, 1);
  assert.deepEqual(extractPrRecord(state.body), currentRecord());
});

test('merge replaces an old record block with the current head instead of duplicating it', async () => {
  const stale = structuredClone(currentRecord());
  stale.verdicts[0].sha = 'old5678';
  const { state, entry } = bodyWriteFixture({ body: upsertPrRecord('Summary', stale) });
  assert.equal(await entry(340, evidence), 'merged');
  assert.equal(state.body.match(/```rt-record/g).length, 1);
  assert.deepEqual(extractPrRecord(state.body), currentRecord());
});

test('merge refuses when the body still carries a stale record after the update', async () => {
  const stale = structuredClone(currentRecord());
  stale.verdicts[0].sha = 'old5678';
  const { calls, entry } = bodyWriteFixture({ body: upsertPrRecord('Body', stale), persist: false });
  await assert.rejects(entry(340, evidence), /PR record is missing or stale after the pull request body update/);
  assert.deepEqual(calls, ['write:340']);
});

test('merge refuses with a clear error when the body update fails and never squashes', async () => {
  const { calls, entry } = bodyWriteFixture({ fail: new Error('provider down') });
  await assert.rejects(entry(340, evidence), /PR record update failed: provider down/);
  assert.deepEqual(calls, ['write:340']);
});

test('live: a body write the provider silently drops is refused by the provider re-read and never squashes', async () => {
  const calls = [];
  const github = {
    async getPullRequest() { return pr; },
    async requiredGreen() { return true; },
    async squashMerge(number) { calls.push(`squash:${number}`); return 'merged'; },
  };
  const pullRequestBody = {
    async read() { calls.push('read'); return 'Body'; },
    async write(number) { calls.push(`write:${number}`); },
  };
  const persisted = { issue: '340', head: HEAD, tree: TREE, passed: ALL, safetyFiles: [], safetyApproved: false };
  const entry = createMergeEntryPoint({ mode: 'agent', gateState: { async get() { return persisted; } }, github, pullRequestBody });
  await assert.rejects(entry(340, evidence), /PR record is missing or stale after the pull request body update/);
  assert.deepEqual(calls, ['read', 'write:340', 'read']);
});
