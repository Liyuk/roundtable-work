import test from 'node:test';
import assert from 'node:assert/strict';
import { runGates } from '../../runtime/lib/gates.mjs';
import { createMergeEntryPoint } from '../../runtime/lib/merge.mjs';
import { extractPrRecord } from '../../runtime/lib/pr-record.mjs';

const RATIONALE = 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.';

// Production-shaped path: runGates hands evidence to the real merge entry point, which writes the PR body record.
const routing = { facts: { roles: { reviewer: { harness: 'host-agent', model: 'model-review' } } }, prompts: {} };

function mergedRun({ reviewer = { passed: true, head: 'abc1234', rationale: RATIONALE }, usageRows } = {}) {
  const records = new Map();
  const ledger = [];
  const store = { async load() { return { ledger }; }, async append(_id, entry) { if (!ledger.some((e) => e.id === entry.id)) ledger.push(entry); } };
  let body = 'Closes #53';
  const merge = createMergeEntryPoint({
    mode: 'agent',
    gateState: { async get(id) { return records.get(id); } },
    store,
    github: {
      async getPullRequest() { return { state: 'open', draft: false, head: 'abc1234', mergeable: true, files: [] }; },
      async requiredGreen() { return { green: true }; },
      async squashMerge() { return 'merged'; },
    },
    pullRequestBody: { async read() { return body; }, async write(_pr, next) { body = next; } },
  });
  return runGates({
    issue: '53', head: 'abc1234', tree: 'tree-a', pr: 90, changedFiles: [], usageRows,
    models: { reviewer: 'model-review' }, routing,
    state: { async get(id) { return records.get(id); }, async put(id, value) { records.set(id, structuredClone(value)); } },
    store,
    gates: { async gate0() { return { passed: true }; }, async reviewer() { return reviewer; } },
    ci: { async requiredGreen() { return { green: true }; } },
    merge: { squash: merge },
    github: { async getPullRequest() { return { body: 'Closes #53' }; }, async addLabel() {}, async recordedEscalationApproval() { return null; } },
  }).then((result) => ({ result, record: extractPrRecord(body) }));
}

test('merged PR body record carries gate1 role and harness from the reviewer result', async () => {
  const { result, record } = await mergedRun();
  assert.equal(result.status, 'merged');
  const gate1 = record.rounds.find((round) => round.gate === 'gate1');
  assert.equal(gate1.role, 'reviewer');
  assert.equal(gate1.harness, 'host-agent');
  assert.equal(gate1.model, 'model-review');
});

test('merged PR body usage sums only usageKnown rows', async () => {
  const usageRows = [
    { issue: '53', role: 'developer', harness: 'host-agent', model: 'm', usageKnown: true, inputTokens: 10, outputTokens: 5 },
    { issue: '53', role: 'reviewer', harness: 'host-agent', model: 'm', usageKnown: false, inputTokens: 0, outputTokens: 0 },
    { issue: '53', role: 'reviewer', harness: 'host-agent', model: 'm', usageKnown: true, inputTokens: 3, outputTokens: 2 },
  ];
  const { record } = await mergedRun({ usageRows });
  assert.deepEqual(record.usage, { usageKnown: true, inputTokens: 13, outputTokens: 7, calls: 2 });
});

test('merged PR body usage is usageKnown:false without usage rows', async () => {
  const { record } = await mergedRun({ usageRows: [] });
  assert.deepEqual(record.usage, { usageKnown: false });
});
