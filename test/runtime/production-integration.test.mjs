import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionAdapter } from '../../runtime/lib/production.mjs';

test('production adapter rejects missing providers with a concrete diagnostic', () => {
  assert.throws(() => createProductionAdapter({}), /provider.*required/i);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runQueue } from '../../runtime/rtd.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';

const BASE_SHA = 'a'.repeat(40);
const REVERT_SHA = 'b'.repeat(40);
function observationProvider() {
  let sha = BASE_SHA;
  return { expectedSha({ expectedSha }) { sha = expectedSha ?? BASE_SHA; return sha; },
    issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
    worktree: { async inspect() { return { dirty: false }; } },
    git: { async head() { return sha; }, async commit() { return { sha }; } },
    evidence: { async checks() { return { sha, conclusion: 'success' }; }, async review() { return { sha, conclusion: 'approved' }; } } };
}

test('an in-flight recovery effect stays paused and requests human intervention once', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt121-test-'));
  const calls = [];
  const autoMerge = createProductionAdapter({
    pause: { async get() { return null; }, async put() {} },
    github: {
      async getPullRequest() { return { state: 'open', draft: false, mergeable: true, head: 'head', files: ['x'] }; },
      async requiredGreen() { return true; }, async squashMerge() { return { mergeCommit: 'abcdef0123456789' }; },
      async addLabel() {}, async recordedEscalationApproval() { return null; },
      async mainStatus() { return { head: 'abcdef0123456789', status: 'red' }; },
      async openRevertPullRequest() { return { number: 91, head: 'reverthead' }; },
      async createIssue(input) { calls.push(['issue', input]); return { number: 121 }; },
    },
    git: { async createRevert() { calls.push('revert'); return { sha: '1234567' }; } },
    observation: observationProvider(),
    context: { async get() { throw new Error('recovery must not proceed'); } },
    gates: { async gate0() { return true; }, async reviewer() { return { passed: true, head: 'head' }; }, async crossCheck() { return true; } },
  });
  try {
    const store = await createStateStore({ workRoot: root });
    await store.update('rt-main-monitor', (state) => {
      state.mainMonitor = { stage: 'monitoring', mergeCommit: 'abcdef0123456789', recovery: { revert: { inFlight: true } } };
    });

    const result = await runQueue({ workRoot: root, queue: ['54'], autoMerge, handler: async () => { throw new Error('queue item must not run'); } });

    assert.equal(result.status, 'ok');
    assert.deepEqual(result.skipped, [{ id: '54', reason: 'main_paused' }]);
    assert.deepEqual(calls.map((call) => Array.isArray(call) ? call[0] : call), ['issue']);
    assert.deepEqual(calls[0][1].labels, ['type:bug', 'rt:self']);
    assert.match(calls[0][1].body, /human intervention/i);
    const monitor = (await store.load('rt-main-monitor')).mainMonitor;
    assert.deepEqual(monitor.recovery.revert, { inFlight: true });
    assert.deepEqual(monitor.recovery.interventions.revert, {
      done: true, value: { number: 121 },
      reason: 'Recovery revert outcome is unknown; main remains paused',
    });
    const later = await runQueue({ workRoot: root, queue: ['55'], autoMerge, handler: async () => { throw new Error('later queue item must not run'); } });
    assert.deepEqual(later.skipped, [{ id: '55', reason: 'main_paused' }]);
    assert.equal(calls.length, 1, 'the later pass neither repeats the revert nor creates another intervention issue');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('distinct unknown recovery effects each receive an intervention notification', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt121-test-'));
  const calls = [];
  const autoMerge = createProductionAdapter({
    github: {
      async getPullRequest() {}, async requiredGreen() {}, async squashMerge() {}, async addLabel() {},
      async recordedEscalationApproval() {}, async mainStatus() { return { head: 'abcdef0123456789', status: 'red' }; },
      async openRevertPullRequest() { throw new Error('must not repeat pull request'); },
      async createIssue(input) { calls.push(input); return { number: 120 + calls.length }; },
    },
    git: { async createRevert() { throw new Error('must not repeat revert'); } },
    observation: observationProvider(),
    context: { async get() {} }, gates: { async gate0() {}, async reviewer() {}, async crossCheck() {} },
  });
  try {
    const store = await createStateStore({ workRoot: root });
    await store.update('rt-main-monitor', (state) => {
      state.mainMonitor = { stage: 'monitoring', mergeCommit: 'abcdef0123456789', recovery: { revert: { inFlight: true } } };
    });
    const run = () => runQueue({ workRoot: root, queue: ['54'], autoMerge, handler: async () => { throw new Error('must stay paused'); } });
    assert.deepEqual((await run()).skipped, [{ id: '54', reason: 'main_paused' }]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body, /`revert`/);
    store.setEpoch((await store.load('rt-main-monitor')).lockEpoch);
    await store.update('rt-main-monitor', (state) => {
      state.mainMonitor.recovery.revert = { done: true, value: { sha: '1234567' } };
      state.mainMonitor.recovery.pullRequest = { inFlight: true };
    });
    assert.deepEqual((await store.load('rt-main-monitor')).mainMonitor.recovery.pullRequest, { inFlight: true });
    assert.deepEqual((await run()).skipped, [{ id: '54', reason: 'main_paused' }]);
    assert.equal(calls.length, 2, 'the later unknown effect has its own notification');
    assert.match(calls[1].body, /`pullRequest`/);
    await run();
    assert.equal(calls.length, 2, 'repeated passes do not duplicate either notification');
    const recovery = (await store.load('rt-main-monitor')).mainMonitor.recovery;
    assert.equal(recovery.interventions.revert.done, true);
    assert.equal(recovery.interventions.pullRequest.done, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ['throws', 'null', 'restart']) {
  test(`unknown intervention notification remains actionable after ${scenario}`, async () => {
    const root = await mkdtemp(join(process.cwd(), 'rt121-test-'));
    let calls = 0;
    const autoMerge = createProductionAdapter({
      github: {
        async getPullRequest() {}, async requiredGreen() {}, async squashMerge() {}, async addLabel() {},
        async recordedEscalationApproval() {}, async mainStatus() { return { head: 'abcdef0123456789', status: 'red' }; },
        async openRevertPullRequest() {}, async createIssue() { calls++; if (scenario === 'throws') throw new Error('network failure'); return null; },
      },
      git: { async createRevert() { throw new Error('must not repeat'); } },
      observation: observationProvider(),
      context: { async get() {} }, gates: { async gate0() {}, async reviewer() {}, async crossCheck() {} },
    });
    try {
      const store = await createStateStore({ workRoot: root });
      await store.update('rt-main-monitor', (state) => {
        state.mainMonitor = { stage: 'monitoring', mergeCommit: 'abcdef0123456789', recovery: {
          revert: { inFlight: true }, ...(scenario === 'restart' ? { intervention: { inFlight: true, reason: 'unknown' } } : {}),
        } };
      });
      const run = () => runQueue({ workRoot: root, queue: ['54'], autoMerge, handler: async () => { throw new Error('must stay paused'); } });
      await assert.rejects(run(), /(?:network failure|no result|notification.*unknown)/i);
      await assert.rejects(run(), /notification.*unknown.*human intervention/i);
      assert.equal(calls, scenario === 'restart' ? 0 : 1);
      const recovery = (await store.load('rt-main-monitor')).mainMonitor.recovery;
      assert.equal((scenario === 'restart' ? recovery.intervention : recovery.interventions.revert).inFlight, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('an uncertain notification does not duplicate or hide a different unknown effect', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt121-test-'));
  const calls = [];
  const autoMerge = createProductionAdapter({
    github: {
      async getPullRequest() {}, async requiredGreen() {}, async squashMerge() {}, async addLabel() {},
      async recordedEscalationApproval() {}, async mainStatus() { return { head: 'abcdef0123456789', status: 'red' }; },
      async openRevertPullRequest() {}, async createIssue(input) { calls.push(input); return { number: 122 }; },
    },
    git: { async createRevert() {} }, context: { async get() {} }, observation: observationProvider(),
    gates: { async gate0() {}, async reviewer() {}, async crossCheck() {} },
  });
  try {
    const store = await createStateStore({ workRoot: root });
    await store.update('rt-main-monitor', (state) => {
      state.mainMonitor = { stage: 'monitoring', mergeCommit: 'abcdef0123456789', recovery: {
        revert: { inFlight: true }, pullRequest: { inFlight: true },
        interventions: { revert: { inFlight: true, reason: 'Recovery revert outcome is unknown; main remains paused' } },
      } };
    });
    const run = () => runQueue({ workRoot: root, queue: ['54'], autoMerge, handler: async () => { throw new Error('must stay paused'); } });
    await assert.rejects(run(), /notification.*unknown.*human intervention/i);
    await assert.rejects(run(), /notification.*unknown.*human intervention/i);
    assert.equal(calls.length, 1);
    assert.match(calls[0].body, /`pullRequest`/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const status of [{ head: 'changed', status: 'red' }, { head: 'changed', status: 'green' }]) {
  test(`unknown recovery is surfaced when main is ${status.status} with changed HEAD`, async () => {
    const root = await mkdtemp(join(process.cwd(), 'rt121-test-'));
    let calls = 0;
    const autoMerge = createProductionAdapter({
      github: {
        async getPullRequest() {}, async requiredGreen() {}, async squashMerge() { throw new Error('must not repeat'); }, async addLabel() {},
        async recordedEscalationApproval() {}, async mainStatus() { return status; }, async openRevertPullRequest() {},
        async createIssue() { calls++; return { number: 121 }; },
      },
      git: { async createRevert() {} }, context: { async get() {} }, observation: observationProvider(),
      gates: { async gate0() {}, async reviewer() {}, async crossCheck() {} },
    });
    try {
      const store = await createStateStore({ workRoot: root });
      await store.update('rt-main-monitor', (state) => { state.mainMonitor = { stage: 'monitoring', mergeCommit: 'abcdef0123456789', recovery: { revertMerged: { inFlight: true } } }; });
      const result = await runQueue({ workRoot: root, queue: ['54'], autoMerge, handler: async () => { throw new Error('must stay paused'); } });
      assert.deepEqual(result.skipped, [{ id: '54', reason: 'main_paused' }]);
      assert.equal(calls, 1);
      assert.equal((await store.load('rt-main-monitor')).mainMonitor.recovery.interventions.revertMerged.done, true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('production adapter triggers recovery after red main and holds later work', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt53-test-'));
  const calls = [];
  const github = {
    async getPullRequest(pr) { return { state: 'open', draft: false, mergeable: true, head: pr === 90 ? BASE_SHA : REVERT_SHA, files: ['x'] }; },
    async requiredGreen() { return true; },
    async squashMerge(pr, options) { calls.push(['merge', pr, options]); return { mergeCommit: pr === 90 ? 'abcdef0123456789' : '1111111111111111' }; },
    async addLabel() {}, async recordedEscalationApproval() {},
    async mainStatus() { return { head: 'abcdef0123456789', status: 'red' }; },
    async openRevertPullRequest() { calls.push('revert-pr'); return { number: 91, head: REVERT_SHA }; },
    async createIssue() { calls.push('bug'); return { number: 92 }; },
  };
  const providers = {
    github, git: { async createRevert() { calls.push('revert'); return { sha: '1234567' }; } },
    context: { async get({ recovery }) { return recovery ? { pr: 91, head: REVERT_SHA, tree: 'reverttree', highRisk: false, changedFiles: ['x'] } : { pr: 90, head: BASE_SHA, tree: 'tree', highRisk: false, changedFiles: ['x'] }; } },
    gates: { async gate0() { calls.push('gate0'); return true; }, async reviewer({ head }) { calls.push('reviewer'); return { passed: true, head }; }, async crossCheck() { return true; } },
    observation: observationProvider(),
  };
  const handler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' });
  try {
    const autoMerge = createProductionAdapter(providers);
    await runQueue({ workRoot: root, queue: ['53'], handler, autoMerge });
    assert.deepEqual(calls.filter(Array.isArray).map(x => x[1]), [90, 91]);
    assert.deepEqual(calls.filter(Array.isArray).map(x => x[2]), [{ method: 'squash' }, { method: 'squash' }]);
    assert.deepEqual(calls.filter(x => typeof x === 'string'), ['gate0', 'reviewer', 'revert', 'revert-pr', 'bug', 'gate0', 'reviewer']);
    let ran = false;
    await runQueue({ workRoot: root, queue: ['54'], handler: async () => { ran = true; }, autoMerge });
    assert.equal(ran, false);
    const held = await runQueue({ workRoot: root, queue: ['54'], handler: async () => { ran = true; } });
    assert.equal(held.skipped[0].reason, 'main_paused');
    assert.equal(ran, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function cliFixture(root, status, revertGreen = true) {
  const log = join(root, 'calls.jsonl');
  await writeFile(join(root, 'queue.json'), JSON.stringify(['53', '54']));
  await writeFile(join(root, 'handler.mjs'), `export default async ({phase}) => ({exitCode:0, output:phase === 'reviewing' ? '审查结论：通过' : 'ok'});`);
  await writeFile(join(root, 'providers.mjs'), `
import { appendFile } from 'node:fs/promises';
const log = async (...v) => appendFile(${JSON.stringify(log)}, JSON.stringify(v)+'\\n');
export default {
 context: { async get({recovery}) { return recovery ? {pr:91,head:'${REVERT_SHA}',tree:'reverttree',highRisk:false,changedFiles:['x']} : {pr:90,head:'${BASE_SHA}',tree:'tree',highRisk:false,changedFiles:['x']}; } },
 gates: { async gate0() { await log('gate0'); return true; }, async reviewer({head}) { await log('reviewer'); return {passed:true,head}; }, async crossCheck() { return true; } },
 git: { async createRevert() { await log('revert'); return {sha:'1234567'}; } },
 github: {
  async getPullRequest(pr) { return {state:'open',draft:false,mergeable:true,head:pr === 90 ? '${BASE_SHA}' : '${REVERT_SHA}',files:['x']}; },
  async requiredGreen(pr) { return pr === 90 || ${revertGreen}; },
  async squashMerge(pr,options) { await log('squash',pr,options); return {mergeCommit:pr === 90 ? 'abcdef0123456789' : '1111111111111111'}; },
  async addLabel() {}, async recordedEscalationApproval() {},
  async mainStatus() { return {head:'abcdef0123456789',status:${JSON.stringify(status)}}; },
  async openRevertPullRequest() { await log('revert-pr'); return {number:91,head:'${REVERT_SHA}'}; },
  async createIssue(arg) { await log('bug',arg.labels); return {number:92}; },
 },
 observation: (() => { let sha='${BASE_SHA}'; return {
  expectedSha({expectedSha}) { sha=expectedSha || '${BASE_SHA}'; return sha; },
  issue:{async get(){return {state:'open',labels:['rt:running']};}}, worktree:{async inspect(){return {dirty:false};}},
  git:{async head(){return sha;},async commit(){return {sha};}},
  evidence:{async checks(){return {sha,conclusion:'success'};},async review(){return {sha,conclusion:'approved'};}}
 }; })()
};`);
  return log;
}

function runCli(root, providers = 'providers.mjs') {
  const cli = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
  return spawnSync(process.execPath, [cli, '--work-root', root, '--queue', 'queue.json', '--routing', fileURLToPath(new URL('./routing-fixture.json', import.meta.url)), '--handler', join(root, 'handler.mjs'), '--providers', join(root, providers)], { encoding: 'utf8' });
}

test('CLI production providers perform unattended green and red-main recovery through guarded gates', async () => {
  for (const status of ['green', 'red']) {
    const root = await mkdtemp(join(process.cwd(), 'rt53-cli-'));
    try {
      const log = await cliFixture(root, status);
      const child = runCli(root);
      assert.equal(child.status, 0, child.stderr);
      const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
      const squashes = calls.filter(x => x[0] === 'squash');
      assert.deepEqual(squashes.map(x => x[1]), status === 'red' ? [90, 91] : [90, 90]);
      assert.ok(squashes.every(x => JSON.stringify(x[2]) === JSON.stringify({ method: 'squash' })));
      if (status === 'red') {
        assert.deepEqual(calls.map(x => x[0]), ['gate0', 'reviewer', 'squash', 'revert', 'revert-pr', 'bug', 'gate0', 'reviewer', 'squash']);
        assert.deepEqual(calls.find(x => x[0] === 'bug')[1], ['type:bug', 'rt:self']);
        assert.equal(JSON.parse(child.stdout).skipped[0].reason, 'main_paused');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('CLI keeps pending revert paused on restart and rejects missing providers', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt53-cli-'));
  try {
    const log = await cliFixture(root, 'red', false);
    let child = runCli(root);
    assert.equal(child.status, 0, child.stderr);
    const providerPath = join(root, 'providers.mjs');
    await writeFile(providerPath, (await readFile(providerPath, 'utf8')).replace("head:'abcdef0123456789',status:'red'", "head:'2222222222222222',status:'green'"));
    child = runCli(root);
    assert.equal(child.status, 0, child.stderr);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.filter(x => x[0] === 'squash').map(x => x[1]), [90]);
    assert.equal(calls.filter(x => x[0] === 'revert-pr').length, 1);
    assert.ok(JSON.parse(child.stdout).skipped.every(x => x.reason === 'main_paused'));
    await writeFile(join(root, 'missing.mjs'), 'export default {};');
    child = runCli(root, 'missing.mjs');
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /provider context.get is required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('advanced green main after initial merge admits the next item', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt53-cli-'));
  try {
    const log = await cliFixture(root, 'green');
    const path = join(root, 'providers.mjs');
    await writeFile(path, (await readFile(path, 'utf8')).replace("head:'abcdef0123456789',status:", "head:'2222222222222222',status:"));
    const child = runCli(root);
    assert.equal(child.status, 0, child.stderr);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.filter(x => x[0] === 'squash').map(x => x[1]), [90, 90]);
    assert.deepEqual(JSON.parse(child.stdout).skipped, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pending main and failed revert gate hold tracker claims across passes', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt53-test-'));
  let main = 'pending';
  let mainHead = 'abcdef0123456789';
  let gatePass = true;
  const calls = [];
  const pause = { value: null, async get() { return this.value; }, async put(value) { this.value = structuredClone(value); } };
  const github = {
    async getPullRequest(pr) { return { state: 'open', draft: false, mergeable: true, head: pr === 90 ? BASE_SHA : REVERT_SHA, files: ['x'] }; },
    async requiredGreen() { return true; }, async addLabel() {}, async recordedEscalationApproval() {},
    async squashMerge(pr) { calls.push(pr); return { mergeCommit: 'abcdef0123456789' }; },
    async mainStatus() { return { head: mainHead, status: main }; },
    async openRevertPullRequest() { return { number: 91, head: REVERT_SHA }; },
    async createIssue() { return { number: 92 }; },
  };
  const autoMerge = createProductionAdapter({ pause, github,
    git: { async createRevert() { return { sha: '1234567' }; } },
    context: { async get({ recovery }) { return { pr: recovery ? 91 : 90, head: recovery ? REVERT_SHA : BASE_SHA, tree: 'tree', highRisk: false, changedFiles: ['x'] }; } },
    gates: { async gate0({ issue }) { return issue === '53' || gatePass; }, async reviewer({ head }) { return { passed: true, head }; }, async crossCheck() { return true; } },
    observation: observationProvider(),
  });
  const handler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' });
  try {
    await runQueue({ workRoot: root, queue: ['53'], handler, autoMerge });
    assert.deepEqual(calls, [90]);
    const trackerCalls = [];
    const tracker = { async addLabel() { trackerCalls.push('label'); }, async createComment() { trackerCalls.push('comment'); } };
    let result = await runQueue({ workRoot: root, repoRoot: root, githubClient: tracker, queue: [{ id: '54', number: 54 }], handler, autoMerge });
    assert.equal(result.skipped[0].reason, 'main_paused');
    assert.deepEqual(trackerCalls, []);
    main = 'red'; gatePass = false;
    await assert.rejects(runQueue({ workRoot: root, queue: ['54'], handler, autoMerge }), /Revert gate0/);
    assert.deepEqual(calls, [90]);
    gatePass = true;
    result = await runQueue({ workRoot: root, queue: ['54'], handler, autoMerge });
    assert.deepEqual(calls, [90, 91]);
    assert.equal(result.skipped[0].reason, 'main_paused');
    main = 'green';
    mainHead = '2222222222222222';
    result = await runQueue({ workRoot: root, queue: [], handler, autoMerge });
    assert.equal(pause.value, null);
    assert.equal(result.status, 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});
