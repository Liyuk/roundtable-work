import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runQueue } from '../../runtime/rtd.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { observeAndCheckTransition } from '../../runtime/lib/observe.mjs';

const sha = 'a'.repeat(40);
function clients(overrides = {}) {
  const writes = [];
  return {
    writes,
    issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
    worktree: { async inspect() { return { dirty: false }; } },
    git: { async head() { return sha; }, async commit() { return { sha }; } },
    evidence: { async checks() { return { sha, conclusion: 'success' }; }, async review() { return { sha, conclusion: 'approved' }; } },
    ...overrides,
  };
}
const check = (c) => observeAndCheckTransition({ clients: c, issue: { id: '109' }, expectedSha: sha });

test('observation allows a consistent claimed issue, clean worktree, HEAD, checks, and review', async () => {
  const c = clients();
  const result = await check(c);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.snapshot, { issue: { state: 'open', labels: ['rt:running'] }, worktree: { dirty: false }, head: sha, commit: { sha }, checks: { sha, conclusion: 'success' }, review: { sha, conclusion: 'approved' } });
  assert.deepEqual(c.writes, []);
});

test('observation fails closed with structured reasons for dirty tree, missing HEAD, stale checks, and read failures', async (t) => {
  const cases = [
    ['dirty worktree', { worktree: { async inspect() { return { dirty: true }; } } }, 'worktree_dirty'],
    ['missing HEAD', { git: { async head() { return null; }, async commit() { return { sha }; } } }, 'head_unknown'],
    ['checks for another SHA', { evidence: { async checks() { return { sha: 'b'.repeat(40), conclusion: 'success' }; }, async review() { return { sha, conclusion: 'approved' }; } } }, 'checks_sha_mismatch'],
    ['unknown or failed read', { issue: { async get() { throw new Error('unavailable'); } } }, 'issue_read_failed'],
  ];
  for (const [name, overrides, reason] of cases) await t.test(name, async () => {
    const c = clients(overrides);
    const result = await check(c);
    assert.equal(result.allowed, false);
    assert.ok(result.mismatches.some((m) => m.reason === reason));
    assert.deepEqual(c.writes, []);
  });
});

test('runQueue checks observation immediately before checkpoint and waits without advancing on mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-observe-'));
  try {
    await (await createStateStore({ workRoot: root })).checkpoint('109', 'reviewing');
    const c = clients({ worktree: { async inspect() { return { dirty: true }; } } });
    const result = await runQueue({ workRoot: root, queue: ['109'], observationClients: c,
      handler: async () => ({ exitCode: 0, output: 'ok', expectedSha: sha }) });
    assert.equal(result.outcomes[0].status, 'waiting_external', JSON.stringify(result));
    assert.ok(result.outcomes[0].observation.mismatches.some((m) => m.reason === 'worktree_dirty'));
    const state = await (await createStateStore({ workRoot: root })).load('109');
    assert.equal(state.checkpoint.phase, 'reviewing');
    assert.deepEqual(c.writes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production adapter requires observation providers', async () => {
  const { createProductionAdapter } = await import('../../runtime/lib/production.mjs');
  const fn = async () => {};
  const providers = {
    context: { get: fn }, gates: { gate0: fn, reviewer: fn, crossCheck: fn },
    github: Object.fromEntries(['getPullRequest', 'requiredGreen', 'squashMerge', 'addLabel', 'recordedEscalationApproval', 'mainStatus', 'openRevertPullRequest', 'createIssue', 'createComment'].map((name) => [name, fn])),
    git: { createRevert: fn },
  };
  assert.throws(() => createProductionAdapter(providers), /observation/i);
  providers.observation = clients();
  const adapter = createProductionAdapter(providers);
  assert.equal(adapter.production, true);
  assert.equal(adapter.observationClients, providers.observation);
  await assert.rejects(runQueue({ workRoot: '/unused', queue: [], handler: async () => ({}), autoMerge: { production: true } }), /observation clients are required/);
});

test('decision updates are held when observation mismatches, and proceed when it matches', async () => {
  for (const mismatch of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'rt-observe-decision-'));
    try {
      const store = await createStateStore({ workRoot: root });
      await store.checkpoint('109', 'reviewing');
      const c = clients(mismatch ? { worktree: { async inspect() { return { dirty: true }; } } } : {});
      const result = await runQueue({ workRoot: root, queue: ['109'], observationClients: c,
        handler: async ({ phase }) => phase === 'finalizing'
          ? { exitCode: 0, decision: { decision: 'do', reason: 'continue' }, expectedSha: sha }
          : { exitCode: 0, output: 'ok', expectedSha: sha } });
      const state = await (await createStateStore({ workRoot: root })).load('109');
      if (mismatch) {
        assert.equal(result.outcomes[0].status, 'waiting_external');
        assert.equal(state.status, 'waiting_external');
        assert.equal(state.lastEvent.type, 'observation_failed');
      } else {
        assert.equal(result.outcomes[0].status, 'queued');
        assert.equal(state.lastEvent.type, 'decision_do');
      }
      assert.deepEqual(c.writes, []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('production merge is held before squash when the observed SHA differs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-observe-merge-'));
  try {
    await (await createStateStore({ workRoot: root })).checkpoint('109', 'reviewing');
    const c = clients({ git: { async head() { return 'b'.repeat(40); }, async commit() { return { sha: 'b'.repeat(40) }; } } });
    let squashes = 0;
    const github = {
      async getPullRequest() { return { state: 'open', head: sha, mergeable: true, files: [] }; },
      async requiredGreen() { return true; }, async squashMerge() { squashes++; return { mergeCommit: sha }; },
      async addLabel() {}, async recordedEscalationApproval() { return { approved: false }; },
      async mainStatus() { return { head: sha, status: 'green' }; }, async openRevertPullRequest() {}, async createIssue() {},
    };
    const autoMerge = {
      production: true, observationClients: c,
      async context() { return { pr: 1, head: sha, tree: 'tree', highRisk: false, changedFiles: [] }; },
      gates: { async gate0() { return true; }, async reviewer() { return { passed: true, head: sha }; }, async crossCheck() { return true; } },
      github, git: { async createRevert() {} },
    };
    const result = await runQueue({ workRoot: root, queue: ['109'], autoMerge, observationClients: c,
      handler: async ({ phase }) => ({ exitCode: 0, expectedSha: sha, ...(phase === 'finalizing' ? {} : { output: 'ok' }) }) });
    assert.equal(result.outcomes[0].status, 'waiting_external');
    assert.equal(squashes, 0);
    assert.equal((await (await createStateStore({ workRoot: root })).load('109')).checkpoint.phase, 'reviewing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the merge call head cannot replace the immutable transition target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-observe-merge-target-'));
  try {
    await (await createStateStore({ workRoot: root })).checkpoint('109', 'reviewing');
    const other = 'b'.repeat(40);
    let head = sha;
    const c = clients({
      git: { async head() { return head; }, async commit() { return { sha: head }; } },
      evidence: { async checks() { return { sha: head, conclusion: 'success' }; }, async review() { return { sha: head, conclusion: 'approved' }; } },
    });
    let squashes = 0;
    const autoMerge = {
      production: true, observationClients: c,
      async context() { return { pr: 1, head: other, tree: 'tree', highRisk: false, changedFiles: [] }; },
      gates: { async gate0() { head = other; return true; }, async reviewer() { return { passed: true, head: other }; }, async crossCheck() { return true; } },
      github: {
        async getPullRequest() { return { state: 'open', head: other, mergeable: true, files: [] }; },
        async requiredGreen() { return true; }, async squashMerge() { squashes++; return { mergeCommit: other }; },
        async addLabel() {}, async recordedEscalationApproval() { return { approved: false }; },
        async mainStatus() { return { head: other, status: 'green' }; }, async openRevertPullRequest() {}, async createIssue() {},
      },
      git: { async createRevert() {} },
    };
    const result = await runQueue({ workRoot: root, queue: ['109'], autoMerge, observationClients: c,
      handler: async () => ({ exitCode: 0, expectedSha: sha }) });
    assert.equal(squashes, 0, 'a merge call head differing from the transition target must not merge');
    assert.equal(result.outcomes[0].status, 'waiting_external');
    assert.equal(result.outcomes[0].class, 'finalize_hold');
    assert.equal((await (await createStateStore({ workRoot: root })).load('109')).checkpoint.phase, 'reviewing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('early phases advance without evidence that does not yet exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-observe-phases-'));
  try {
    let current;
    const phases = [];
    const c = clients({ evidence: {
      async checks() { return current === 'developing' ? null : { sha, conclusion: 'success' }; },
      async review() { return current === 'developing' || current === 'testing' ? null : { sha, conclusion: 'approved' }; },
    } });
    const result = await runQueue({ workRoot: root, queue: ['109'], observationClients: c,
      handler: async ({ phase }) => { current = phase; phases.push(phase); return { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok', expectedSha: sha }; } });
    assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing']);
    assert.equal(result.outcomes[0].status, 'done');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('direct queue cannot advance with no observation clients', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-observe-missing-'));
  try {
    const result = await runQueue({ workRoot: root, queue: ['109'], handler: async () => ({ exitCode: 0, output: 'ok', expectedSha: sha }) });
    assert.equal(result.outcomes[0].status, 'waiting_external');
    assert.equal((await (await createStateStore({ workRoot: root })).load('109')).checkpoint, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('provider SHA cannot replace the transition target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-observe-target-'));
  try {
    const other = 'b'.repeat(40);
    const c = clients({ expectedSha() { return other; }, git: { async head() { return other; }, async commit() { return { sha: other }; } }, evidence: { async checks() { return { sha: other, conclusion: 'success' }; }, async review() { return { sha: other, conclusion: 'approved' }; } } });
    const result = await runQueue({ workRoot: root, queue: ['109'], observationClients: c, handler: async () => ({ exitCode: 0, output: 'ok', expectedSha: sha }) });
    assert.equal(result.outcomes[0].status, 'waiting_external');
    assert.equal((await (await createStateStore({ workRoot: root })).load('109')).checkpoint, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('finalizing runs gates before requiring current-head evidence and refuses stale evidence before squash', async () => {
  for (const mode of ['valid', 'stale-check', 'stale-review', 'missing-check', 'failed-review']) {
    const root = await mkdtemp(join(tmpdir(), 'rt-observe-gates-'));
    try {
      await (await createStateStore({ workRoot: root })).checkpoint('109', 'reviewing');
      let gatesRan = false;
      let squashes = 0;
      const c = clients({ evidence: {
        async checks() { return gatesRan && mode !== 'missing-check' ? { sha: mode === 'stale-check' ? 'b'.repeat(40) : sha, conclusion: 'success' } : null; },
        async review() { return gatesRan ? { sha: mode === 'stale-review' ? 'b'.repeat(40) : sha, conclusion: mode === 'failed-review' ? 'rejected' : 'approved' } : null; },
      } });
      const autoMerge = {
        observationClients: c,
        async context() { return { pr: 1, head: sha, tree: 'tree', highRisk: false, changedFiles: [] }; },
        gates: { async gate0() { gatesRan = true; return true; }, async reviewer() { return { passed: true, head: sha }; } },
        github: {
          async requiredGreen() { return true; }, async getPullRequest() { return { state: 'open', head: sha, mergeable: true, files: [] }; },
          async squashMerge() { squashes++; return { mergeCommit: sha }; },
        },
      };
      const result = await runQueue({ workRoot: root, queue: ['109'], autoMerge, handler: async () => ({ exitCode: 0, output: 'ok', expectedSha: sha }) });
      assert.equal(gatesRan, true, 'pre-gate observation must not require gate evidence');
      assert.equal(squashes, mode === 'valid' ? 1 : 0, mode);
      assert.equal(result.outcomes[0].status, mode === 'valid' ? 'done' : 'waiting_external', mode);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('dirty worktree permits development stages but blocks final completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-observe-dirty-'));
  try {
    const phases = [];
    const c = clients({ worktree: { async inspect() { return { dirty: true }; } } });
    const result = await runQueue({ workRoot: root, queue: ['109'], observationClients: c,
      handler: async ({ phase }) => { phases.push(phase); return { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok', expectedSha: sha }; } });
    assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing']);
    assert.equal(result.outcomes[0].status, 'waiting_external');
    assert.ok(result.outcomes[0].observation.mismatches.some((m) => m.reason === 'worktree_dirty'));
    assert.equal((await (await createStateStore({ workRoot: root })).load('109')).checkpoint.phase, 'reviewing');
  } finally { await rm(root, { recursive: true, force: true }); }
});
