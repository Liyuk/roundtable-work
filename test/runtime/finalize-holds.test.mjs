import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { createProductionAdapter } from '../../runtime/lib/production.mjs';
import { runGates } from '../../runtime/lib/gates.mjs';

const PASS = '审查结论：通过';
const SAFETY = '.github/workflows/check.yml';
const BASE_SHA = 'a'.repeat(40);
const REVERT_SHA = 'b'.repeat(40);
const tmp = () => mkdtemp(join(process.cwd(), 'rt118-hold-'));
function observationProvider() {
  let sha;
  return {
    expectedSha({ expectedSha }) { sha = expectedSha ?? BASE_SHA; return sha; },
    issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
    worktree: { async inspect() { return { dirty: false }; } },
    git: { async head() { return sha; }, async commit() { return { sha }; } },
    evidence: { async checks() { return { sha, conclusion: 'success' }; }, async review() { return { sha, conclusion: 'approved' }; } },
  };
}

/**
 * One worktree/GitHub/gate world for the auto-merge step. `w.state` is mutable so a test can clear a hold
 * condition between two `runQueue` passes over the same work root (the persisted gate record and checkpoint
 * are what a resume relies on).
 */
function world(overrides = {}) {
  const w = { calls: [] };
  w.state = {
    ci: true, ciThrow: false, gate0: true, gate0Throw: false,
    review: true, reviewUnavailable: false, reviewHead: BASE_SHA,
    gate2: true, gate2Throw: false, approval: null,
    head: BASE_SHA, tree: 'tree1', changedFiles: ['runtime/rtd.mjs'], highRisk: false,
    ...overrides,
  };
  const log = (value) => { w.calls.push(value); return value; };
  w.github = {
    async addLabel(_pr, label) { log(`label:${label}`); },
    async recordedEscalationApproval() { log('approval'); return w.state.approval; },
    async getPullRequest() { log('pr'); return { state: 'open', draft: false, mergeable: true, head: w.state.head, files: w.state.changedFiles }; },
    async requiredGreen() {
      log('ci');
      if (w.state.ciThrow) throw new Error('checks provider offline');
      return w.state.ci === true ? true : { green: false, status: 'pending' };
    },
    async squashMerge(_pr, options) { log(['squash', options]); return { mergeCommit: 'abcdef0123456789' }; },
    async mainStatus() { log('mainStatus'); return { head: 'abcdef0123456789', status: 'green' }; },
    async openRevertPullRequest() { throw new Error('unexpected revert'); },
    async createIssue() { throw new Error('unexpected bug issue'); },
  };
  w.gates = {
    async gate0() { log('gate0'); if (w.state.gate0Throw) throw new Error('gate0 provider offline'); return w.state.gate0; },
    async reviewer() {
      log('gate1');
      if (w.state.reviewUnavailable) throw Object.assign(new Error('reviewer offline'), { code: 'REVIEWER_UNAVAILABLE' });
      return { passed: w.state.review, head: w.state.reviewHead };
    },
    async crossCheck() { log('gate2'); if (w.state.gate2Throw) throw new Error('cross-check offline'); return w.state.gate2; },
  };
  w.context = { async get() { log('context'); return { pr: 90, head: w.state.head, tree: w.state.tree, highRisk: w.state.highRisk, changedFiles: w.state.changedFiles }; } };
  w.autoMerge = { context: (args) => w.context.get(args), gates: w.gates, github: w.github };
  w.squashes = () => w.calls.filter((entry) => Array.isArray(entry) && entry[0] === 'squash');
  w.count = (name) => w.calls.filter((entry) => entry === name).length;
  return w;
}

/** One pass over the queue for issue 53; `phases` records every handler call of that pass. */
function wake(root, w, phases = []) {
  return runQueue({
    workRoot: root,
    queue: ['53'],
    autoMerge: w.autoMerge,
    handler: async ({ phase }) => {
      phases.push(phase);
      return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' };
    },
  });
}

test('a CI hold waits: waiting_external/wait, recovery untouched, gate record kept, no squash', async () => {
  const root = await tmp();
  try {
    const w = world({ ci: false });
    const phases = [];
    const result = await wake(root, w, phases);
    assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing']);
    assert.deepEqual([result.outcomes[0].status, result.outcomes[0].class, result.outcomes[0].decision], ['waiting_external', 'finalize_hold', 'wait']);
    assert.match(result.outcomes[0].reason, /^ci: /);
    assert.equal(w.squashes().length, 0, 'no merge attempt for a hold');
    assert.equal(w.count('pr'), 0, 'the merge entry point was never reached');
    const store = await createStateStore({ workRoot: root });
    const s = await store.load('53');
    assert.equal(s.status, 'waiting_external', 'not interrupted: the issue is picked up again');
    assert.equal(s.recovery, null, 'recovery is untouched');
    assert.equal(s.attempts.developer, 0, 'a hold spends no developer retry');
    assert.equal(s.checkpoint.phase, 'reviewing', 'the next wake resumes at finalizing');
    assert.equal(s.lastEvent.type, 'finalize_hold');
    assert.deepEqual(s.gateRecord.passed, ['gate0', 'gate1']);
    assert.equal(typeof s.gateRecord.rulesFingerprint, 'string');
    assert.deepEqual([s.gateRecord.head, s.gateRecord.tree], [BASE_SHA, 'tree1']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a later wake resumes at finalizing and merges after the hold cleared without re-running passed gates', async () => {
  const root = await tmp();
  try {
    const w = world({ ci: false });
    assert.equal((await wake(root, w)).outcomes[0].status, 'waiting_external');
    w.state.ci = true;
    w.calls.length = 0;
    const phases = [];
    const second = await wake(root, w, phases);
    assert.equal(second.outcomes[0].status, 'done');
    assert.deepEqual(phases, ['finalizing'], 'the resume starts at the interrupted auto-merge phase');
    assert.equal(w.count('gate0'), 0, 'the passed gate0 is reused from the persisted record');
    assert.equal(w.count('gate1'), 0, 'the passed gate1 is reused from the persisted record');
    assert.deepEqual(w.squashes(), [['squash', { method: 'squash', sha: BASE_SHA }]], 'merged once through the single entry point');
    const s = await createStateStore({ workRoot: root }).then((store) => store.load('53'));
    assert.equal(s.status, 'done');
    assert.deepEqual(s.gateRecord.passed, ['gate0', 'gate1', 'ci']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a prompt change invalidates persisted gate evidence before the hold resumes', async () => {
  const root = await tmp();
  try {
    const w = world({ ci: false });
    assert.equal((await wake(root, w)).outcomes[0].status, 'waiting_external');
    w.state.ci = true;
    const reviewerPrompt = join(root, '.agents/skills/roundtable-work/prompts/roles/reviewer.md');
    await mkdir(join(reviewerPrompt, '..'), { recursive: true });
    await writeFile(reviewerPrompt, 'changed');
    w.calls.length = 0;
    const phases = [];
    const second = await wake(root, w, phases);
    assert.equal(second.outcomes[0].status, 'done');
    assert.deepEqual(phases, ['finalizing']);
    assert.equal(w.count('gate0'), 1);
    assert.equal(w.count('gate1'), 1);
    assert.deepEqual(w.squashes(), [['squash', { method: 'squash', sha: BASE_SHA }]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a safety-approval hold resumes after the approval is recorded for the same head', async () => {
  const root = await tmp();
  try {
    const w = world({ highRisk: true, changedFiles: [SAFETY, 'runtime/rtd.mjs'] });
    const first = await wake(root, w);
    assert.deepEqual([first.outcomes[0].status, first.outcomes[0].class, first.outcomes[0].decision], ['waiting_external', 'finalize_hold', 'wait']);
    assert.match(first.outcomes[0].reason, /^safety-approval: /);
    assert.ok(w.calls.includes('label:rt:ready-to-merge'));
    assert.equal(w.squashes().length, 0);
    const store = await createStateStore({ workRoot: root });
    const held = await store.load('53');
    assert.deepEqual(held.gateRecord.passed, ['gate0', 'gate1', 'gate2'], 'only the missing approval is outstanding');
    assert.equal(held.gateRecord.safetyApproved, false);
    assert.equal(held.attempts.developer, 0);

    w.state.approval = { approved: true, model: 'gpt-6.1-terra', head: BASE_SHA };
    w.calls.length = 0;
    const phases = [];
    const second = await wake(root, w, phases);
    assert.equal(second.outcomes[0].status, 'done');
    assert.deepEqual(phases, ['finalizing']);
    assert.deepEqual([w.count('gate0'), w.count('gate1'), w.count('gate2')], [0, 0, 0], 'no re-run of the passed gates');
    assert.deepEqual(w.squashes(), [['squash', { method: 'squash', sha: BASE_SHA }]]);
    const done = await store.load('53');
    assert.deepEqual(done.gateRecord.passed, ['gate0', 'gate1', 'gate2', 'ci']);
    assert.equal(done.gateRecord.safetyApproved, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a throw from the reviewer gate is a resumable hold, not a terminal failure', async () => {
  const root = await tmp();
  try {
    const w = world({ reviewUnavailable: true });
    const first = await wake(root, w);
    assert.deepEqual([first.outcomes[0].status, first.outcomes[0].decision], ['waiting_external', 'wait']);
    assert.match(first.outcomes[0].reason, /^gate1: /);
    assert.equal(w.count('gate1'), 2, 'the reviewer is retried once, then held');
    assert.equal(w.squashes().length, 0);
    assert.deepEqual((await createStateStore({ workRoot: root }).then((s) => s.load('53'))).gateRecord.passed, ['gate0'], 'gate1 never passed, gate0 is kept');
    // The next wake re-runs the gates that never passed and merges once they do.
    w.state.reviewUnavailable = false;
    w.calls.length = 0;
    const second = await wake(root, w);
    assert.equal(second.outcomes[0].status, 'done');
    assert.equal(w.count('gate0'), 0, 'the gate that passed is reused');
    assert.equal(w.count('gate1'), 1, 'the gate that never passed is re-run');
    assert.deepEqual(w.squashes(), [['squash', { method: 'squash', sha: BASE_SHA }]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a transiently thrown gate or CI provider error is a hold and clears on the next wake', async () => {
  for (const kind of ['gate0', 'ci']) {
    const root = await tmp();
    try {
      const w = world();
      if (kind === 'gate0') w.state.gate0Throw = true; else w.state.ciThrow = true;
      const first = await wake(root, w);
      assert.deepEqual([first.outcomes[0].status, first.outcomes[0].class, first.outcomes[0].decision], ['waiting_external', 'finalize_hold', 'wait'], kind);
      assert.match(first.outcomes[0].reason, new RegExp(`^${kind}: `), kind);
      assert.equal(w.squashes().length, 0, kind);
      assert.equal((await createStateStore({ workRoot: root }).then((s) => s.load('53'))).status, 'waiting_external', kind);

      if (kind === 'gate0') w.state.gate0Throw = false; else w.state.ciThrow = false;
      w.calls.length = 0;
      const second = await wake(root, w);
      assert.equal(second.outcomes[0].status, 'done', kind);
      assert.deepEqual(w.squashes(), [['squash', { method: 'squash', sha: BASE_SHA }]], kind);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('a genuine gate failure stays fail-closed: interrupted/ask, merge never attempted', async () => {
  const cases = {
    'gate0 not-pass': (w) => { w.state.gate0 = false; },
    'reviewer rejection': (w) => { w.state.review = false; },
    'stale reviewer head': (w) => { w.state.reviewHead = 'oldhead'; },
    'gate2 not-pass': (w) => { w.state.highRisk = true; w.state.gate2 = false; },
  };
  for (const [name, breakIt] of Object.entries(cases)) {
    const root = await tmp();
    try {
      const w = world();
      breakIt(w);
      const first = await wake(root, w);
      assert.deepEqual([first.outcomes[0].status, first.outcomes[0].class, first.outcomes[0].decision, first.outcomes[0].phase], ['interrupted', 'finalize_failure', 'ask', 'finalizing'], name);
      assert.equal(w.squashes().length, 0, name);
      const store = await createStateStore({ workRoot: root });
      const s = await store.load('53');
      assert.equal(s.status, 'interrupted', name);
      assert.equal(s.attempts.developer, 0, name);
      assert.equal(s.recovery.resumePhase, 'finalizing', name);
      // The loop does not pick it up again on its own.
      const phases = [];
      assert.equal((await wake(root, w, phases)).outcomes[0].status, 'interrupted', name);
      assert.deepEqual(phases, [], name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('a gate hold never pauses main and writes no monitor record', async () => {
  const root = await tmp();
  try {
    const w = world({ ci: false });
    const pause = { writes: [], value: null, async get() { return this.value; }, async put(value) { this.writes.push(value); this.value = value; } };
    const autoMerge = createProductionAdapter({
      pause, github: w.github, gates: w.gates, context: w.context,
      git: { async createRevert() { throw new Error('unexpected revert'); } },
      observation: observationProvider(),
    });
    const result = await runQueue({ workRoot: root, queue: ['53'], autoMerge, handler: async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' }) });
    assert.deepEqual([result.outcomes[0].status, result.outcomes[0].class], ['waiting_external', 'finalize_hold']);
    assert.deepEqual(pause.writes, [], 'a hold never pauses main');
    assert.equal(w.calls.includes('mainStatus'), false, 'the merge was never attempted');
    const store = await createStateStore({ workRoot: root });
    assert.equal((await store.load('rt-main-monitor')).mainMonitor ?? null, null, 'no monitor record is written');
    const s = await store.load('53');
    assert.equal(s.status, 'waiting_external');
    assert.deepEqual(s.gateRecord.passed, ['gate0', 'gate1'], 'the gate record survives the hold');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a handler-supplied mergeHold field never turns a successful merge into a hold', async () => {
  const root = await tmp();
  try {
    const w = world();
    const result = await runQueue({
      workRoot: root,
      queue: ['53'],
      autoMerge: w.autoMerge,
      handler: async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok', ...(phase === 'finalizing' ? { mergeHold: { gate: 'ci', reason: 'stale field' } } : {}) }),
    });
    assert.equal(result.outcomes[0].status, 'done', 'only the auto-merge step may report a hold');
    assert.deepEqual(w.squashes(), [['squash', { method: 'squash', sha: BASE_SHA }]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/**
 * The same world wired through the production adapter (`autoMerge.production === true`), with a pause
 * provider and controllable merge result / main status, so a failure *after* the squash can be driven.
 */
function productionWorld(overrides = {}) {
  const w = world({ head: BASE_SHA, reviewHead: BASE_SHA, ...overrides });
  w.state.squashResult = { mergeCommit: 'abcdef0123456789' };
  w.state.main = { head: 'abcdef0123456789', status: 'green' };
  w.state.mainThrows = false;
  w.pause = {
    writes: [], value: null,
    async get() { return this.value; },
    async put(value) { this.writes.push(value); this.value = value === null ? null : structuredClone(value); },
  };
  w.github = {
    ...w.github,
    async getPullRequest(pr) {
      w.calls.push(`pr:${pr}`);
      return { state: 'open', draft: false, mergeable: true, head: pr === 90 ? w.state.head : REVERT_SHA, files: w.state.changedFiles };
    },
    async squashMerge(pr, options) { w.calls.push(['squash', pr, options]); return structuredClone(w.state.squashResult); },
    async mainStatus() {
      w.calls.push('mainStatus');
      if (w.state.mainThrows) throw new Error('main status provider offline');
      return structuredClone(w.state.main);
    },
    async openRevertPullRequest() { w.calls.push('revert-pr'); return { number: 91, head: 'reverthead' }; },
    async createIssue() { w.calls.push('bug'); return { number: 92 }; },
  };
  w.context = { async get({ recovery } = {}) {
    w.calls.push('context');
    return recovery
      ? { pr: 91, head: REVERT_SHA, tree: 'reverttree', highRisk: false, changedFiles: ['runtime/rtd.mjs'] }
      : { pr: 90, head: w.state.head, tree: w.state.tree, highRisk: w.state.highRisk, changedFiles: w.state.changedFiles };
  } };
  w.autoMerge = createProductionAdapter({
    pause: w.pause, github: w.github, gates: w.gates, context: w.context,
    git: { async createRevert() { w.calls.push('revert'); return { sha: '1234567' }; } },
    observation: observationProvider(),
  });
  return w;
}

// --- post-merge bookkeeping failures are never finalize failures ---

test('a post-merge invalid mergeCommit ends done with main paused and never squashes again', async () => {
  for (const result of [{}, { mergeCommit: 'not-a-sha' }]) {
    const root = await tmp();
    try {
      const w = productionWorld();
      w.state.squashResult = result;
      const first = await wake(root, w);
      assert.deepEqual([first.outcomes[0].status, first.outcomes[0].class, first.outcomes[0].decision], ['done', 'ok', 'done'], JSON.stringify(result));
      assert.match(first.outcomes[0].reason, /^merge monitor: provider github\.squashMerge must return mergeCommit SHA/, JSON.stringify(result));
      const store = await createStateStore({ workRoot: root });
      const s = await store.load('53');
      assert.equal(s.status, 'done', JSON.stringify(result));
      assert.equal(s.recovery, null, 'the wake is not interrupted');
      assert.equal(s.lastEvent.type, 'ok', JSON.stringify(result));
      assert.match(s.lastEvent.detail, /^merge monitor: /, 'the bookkeeping failure is kept, not dropped');
      const marker = (await store.load('rt-main-monitor')).mainMonitor;
      assert.equal(marker.stage, 'merging', 'main stays paused, no invented SHA');
      assert.deepEqual({ pr: marker.pr, head: marker.head, tree: marker.tree }, { pr: 90, head: BASE_SHA, tree: 'tree1' });
      assert.equal(typeof marker.since, 'number');
      assert.deepEqual(w.pause.value, marker, 'the pause backend keeps the same self-describing hold');
      assert.deepEqual(w.squashes(), [['squash', 90, { method: 'squash', sha: BASE_SHA }]], 'the pull request is squashed once');

      // A later pass starts no new work while main is paused and never re-squashes that pull request.
      w.calls.length = 0;
      w.github.getPullRequest = async () => ({ state: 'unknown' });
      const phases = [];
      const second = await wake(root, w, phases);
      assert.deepEqual(phases, [], JSON.stringify(result));
      assert.deepEqual(second.outcomes, [], JSON.stringify(result));
      assert.deepEqual(second.skipped, [{ id: '53', reason: 'main_paused' }], JSON.stringify(result));
      assert.equal((await store.load('53')).status, 'done');
      const retained = (await store.load('rt-main-monitor')).mainMonitor;
      assert.equal(retained.stage, 'merging');
      assert.deepEqual(w.pause.value, retained);
      assert.equal(w.squashes().length, 0, JSON.stringify(result));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('a post-merge mainStatus failure ends done and keeps the monitoring record for the next pass', async () => {
  for (const [name, breakIt] of Object.entries({
    throws: (w) => { w.state.mainThrows = true; },
    'invalid shape': (w) => { w.state.main = { status: 'unknown' }; },
  })) {
    const root = await tmp();
    try {
      const w = productionWorld();
      breakIt(w);
      const first = await wake(root, w);
      assert.deepEqual([first.outcomes[0].status, first.outcomes[0].class, first.outcomes[0].decision], ['done', 'ok', 'done'], name);
      assert.match(first.outcomes[0].reason, /^merge monitor: /, name);
      const store = await createStateStore({ workRoot: root });
      const s = await store.load('53');
      assert.equal(s.status, 'done', name);
      assert.equal(s.recovery, null, name);
      assert.equal(s.lastEvent.type, 'ok', name);
      assert.match(s.lastEvent.detail, /^merge monitor: /, name);
      const monitor = { stage: 'monitoring', mergeCommit: 'abcdef0123456789' };
      assert.deepEqual((await store.load('rt-main-monitor')).mainMonitor, monitor, name);
      assert.deepEqual(w.pause.value, monitor, name);
      assert.deepEqual(w.squashes(), [['squash', 90, { method: 'squash', sha: BASE_SHA }]], name);

      // A later pass with a good provider still runs monitoring: green clears the monitor, nothing is re-squashed.
      w.state.mainThrows = false;
      w.state.main = { head: '2222222222222222', status: 'green' };
      w.calls.length = 0;
      const phases = [];
      const second = await wake(root, w, phases);
      assert.deepEqual(phases, [], name);
      assert.equal(second.outcomes[0].status, 'done', `${name}: the issue stays terminal done`);
      assert.equal(w.squashes().length, 0, name);
      assert.equal((await store.load('rt-main-monitor')).mainMonitor, null, `${name}: green clears the monitor`);
      assert.equal(w.pause.value, null, name);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('a red main after a post-merge mainStatus failure runs the revert path on the next pass', async () => {
  const root = await tmp();
  try {
    const w = productionWorld();
    w.state.mainThrows = true;
    assert.equal((await wake(root, w)).outcomes[0].status, 'done');
    const store = await createStateStore({ workRoot: root });
    assert.deepEqual((await store.load('rt-main-monitor')).mainMonitor, { stage: 'monitoring', mergeCommit: 'abcdef0123456789' });

    w.state.mainThrows = false;
    w.state.main = { head: 'abcdef0123456789', status: 'red' };
    w.state.reviewHead = REVERT_SHA; // the recovery gates review the revert head
    const phases = [];
    const second = await wake(root, w, phases);
    assert.deepEqual(phases, [], 'main is recovered before new work starts');
    assert.deepEqual(second.outcomes, []);
    assert.deepEqual(second.skipped.map((entry) => entry.reason), ['main_paused']);
    assert.deepEqual(w.squashes().map((entry) => entry[1]), [90, 91], 'the revert pull request is merged, the issue PR is not');
    for (const call of ['revert', 'revert-pr', 'bug']) assert.ok(w.calls.includes(call), call);
    assert.equal(w.count('gate0'), 2, 'the issue merge and the revert merge each ran the gates');
    const monitor = (await store.load('rt-main-monitor')).mainMonitor;
    assert.equal(monitor.recovery.revertMerged.done, true);
    assert.notEqual(w.pause.value, null, 'main stays paused after the revert');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// --- runGates hold discriminator (hold: resumable wait, no merge side effect) ---

function gateFixture(overrides = {}) {
  const calls = [];
  const records = new Map();
  const gates = {
    async gate0() { calls.push('gate0'); return true; },
    async reviewer(arg) { calls.push(`gate1:${arg.attempt}`); return { passed: true, head: BASE_SHA }; },
    async crossCheck() { calls.push('gate2'); return true; },
  };
  const input = {
    issue: '53', head: BASE_SHA, tree: 'tree1', highRisk: false, changedFiles: ['runtime/rtd.mjs'], pr: 90,
    state: {
      async get(id) { return records.get(id); },
      async put(id, value) { records.set(id, structuredClone(value)); },
    },
    ci: { async requiredGreen() { calls.push('ci'); return true; } },
    merge: { async squash() { calls.push('squash'); return { merged: true }; } },
    github: { async recordedEscalationApproval() { return null; }, async addLabel() {} },
    ...overrides,
    gates: { ...gates, ...overrides.gates },
  };
  return { input, calls, records };
}

test('runGates separates a resumable hold from a genuine failure and never merges either', async () => {
  const cases = [
    ['gate0 not-pass', false, 'gate0', () => ({ gates: { async gate0() { return { passed: false }; } } })],
    ['gate0 throws (transient)', true, 'gate0', () => ({ gates: { async gate0() { throw new Error('offline'); } } })],
    ['reviewer rejection', false, 'gate1', () => ({ gates: { async gate0() { return true; }, async reviewer() { return { passed: false, head: BASE_SHA }; } } })],
    ['stale reviewer head', false, 'gate1', () => ({ gates: { async gate0() { return true; }, async reviewer() { return { passed: true, head: 'oldhead' }; } } })],
    ['reviewer unavailable', true, 'gate1', () => ({ gates: { async gate0() { return true; }, async reviewer() { throw Object.assign(new Error('offline'), { code: 'REVIEWER_UNAVAILABLE' }); } } })],
    ['gate2 not-pass', false, 'gate2', () => ({ highRisk: true, gates: { async gate0() { return true; }, async reviewer() { return { passed: true, head: BASE_SHA }; }, async crossCheck() { return false; } } })],
    ['gate2 throws (transient)', true, 'gate2', () => ({ highRisk: true, gates: { async gate0() { return true; }, async reviewer() { return { passed: true, head: BASE_SHA }; }, async crossCheck() { throw new Error('offline'); } } })],
    ['safety approval missing', true, 'safety-approval', () => ({ changedFiles: [SAFETY] })],
    ['CI pending', true, 'ci', () => ({ ci: { async requiredGreen() { return { green: false, status: 'pending' }; } } })],
    ['CI throws', true, 'ci', () => ({ ci: { async requiredGreen() { throw new Error('offline'); } } })],
  ];
  for (const [name, hold, gate, overrides] of cases) {
    const f = gateFixture(overrides());
    const result = await runGates(f.input);
    assert.equal(result.status, 'blocked', name);
    assert.equal(result.gate, gate, name);
    assert.equal(result.hold, hold, `${name}: hold discriminator`);
    assert.equal(f.calls.includes('squash'), false, name);
    assert.equal(typeof result.reason, 'string', name);
  }
});

test('a mismatch before gates cannot add the ready label or squash', async () => {
  const root = await tmp();
  try {
    const w = productionWorld({ changedFiles: [SAFETY] });
    const c = observationProvider();
    c.git = { async head() { return REVERT_SHA; }, async commit() { return { sha: REVERT_SHA }; } };
    w.autoMerge.observationClients = c;
    await (await createStateStore({ workRoot: root })).checkpoint('53', 'reviewing');
    const result = await wake(root, w);
    assert.equal(result.outcomes[0].status, 'waiting_external');
    assert.equal(w.calls.includes('label:rt:ready-to-merge'), false);
    assert.equal(w.squashes().length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a successful merge remains done when issue closes or reads fail afterward', async () => {
  for (const failure of ['closed', 'throws']) {
    const root = await tmp();
    try {
      const w = productionWorld();
      let merged = false;
      const c = observationProvider();
      c.issue = { async get() { if (merged && failure === 'throws') throw new Error('offline'); return { state: merged ? 'closed' : 'open', labels: ['rt:running'] }; } };
      w.autoMerge.observationClients = c;
      const original = w.github.squashMerge;
      w.github.squashMerge = async (...args) => { const result = await original(...args); merged = true; return result; };
      const result = await wake(root, w);
      assert.equal(result.outcomes[0].status, 'done', failure);
      assert.equal(w.squashes().length, 1, failure);
      await wake(root, w);
      assert.equal(w.squashes().length, 1, failure);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
