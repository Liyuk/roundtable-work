import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';

async function runCase(failure) {
  const root = await mkdtemp(join(process.cwd(), 'rt53-test-'));
  const calls = [];
  let ciCalls = 0;
  const github = {
    async addLabel(_pr, label) { calls.push(label); },
    async recordedEscalationApproval() { return null; },
    async getPullRequest() { calls.push('pr'); return { state: 'open', draft: false, mergeable: true, head: 'a'.repeat(40), files: [failure === 'safety' ? '.github/workflows/check.yml' : 'runtime/rtd.mjs'] }; },
    async requiredGreen() { calls.push('ci'); ciCalls++; if (failure === 'ci-error') throw new Error('offline'); if (failure === 'pending') return { green: false, status: 'pending' }; return !(failure === 'ci' || (failure === 'recheck' && ciCalls === 2)); },
    async squashMerge(_pr, options) { calls.push(['squash', options]); },
  };
  const autoMerge = {
    async context() { return { head: 'a'.repeat(40), tree: 'tree', pr: 90, highRisk: true, changedFiles: [failure === 'safety' ? '.github/workflows/check.yml' : 'runtime/rtd.mjs'] }; },
    gates: {
      async gate0() { calls.push('gate0'); return failure !== 'gate0'; },
      async reviewer() { calls.push('gate1'); if (failure === 'unavailable') throw Object.assign(new Error('offline'), { code: 'REVIEWER_UNAVAILABLE' }); return { passed: failure !== 'gate1', head: 'a'.repeat(40) }; },
      async crossCheck() { calls.push('gate2'); return failure !== 'gate2'; },
    }, github,
  };
  try {
    const result = await runQueue({ workRoot: root, queue: ['53'], autoMerge, handler: async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' }) });
    return { result, calls };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('worker completion runs ordered gates and rechecked CI through one squash entry point', async () => {
  const { result, calls } = await runCase();
  assert.equal(result.outcomes[0].status, 'done');
  assert.deepEqual(calls, ['gate0', 'gate1', 'gate2', 'ci', 'pr', 'ci', ['squash', { method: 'squash' }]]);
});

test('worker completion fails closed on gate failures, unavailable reviewer and CI failures', async () => {
  for (const failure of ['gate0', 'gate1', 'gate2', 'unavailable', 'safety', 'ci', 'pending', 'ci-error', 'recheck']) {
    const { result, calls } = await runCase(failure);
    assert.notEqual(result.outcomes[0].status, 'done', failure);
    assert.equal(calls.some(Array.isArray), false, failure);
    if (failure === 'unavailable') assert.equal(calls.filter(x => x === 'gate1').length, 2);
  }
});

test('finalizing decisions are applied before any auto-merge work', async () => {
  for (const decision of [{ decision: { decision: 'do', reason: 'continue' } }, { decisionFile: 'DECISION=continue\nContinue work' }]) {
    const root = await mkdtemp(join(process.cwd(), 'rt53-test-'));
    let contextCalls = 0;
    try {
      const result = await runQueue({ workRoot: root, queue: ['53'], autoMerge: { async context() { contextCalls++; throw new Error('unexpected merge'); } }, handler: async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok', ...(phase === 'finalizing' ? decision : {}) }) });
      assert.equal(result.outcomes[0].status, 'queued');
      assert.equal(contextCalls, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
