import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionAdapter } from '../../runtime/lib/production.mjs';

test('production adapter rejects missing providers with a concrete diagnostic', () => {
  assert.throws(() => createProductionAdapter({}), /provider.*required/i);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';
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
  return spawnSync(process.execPath, [cli, '--work-root', root, '--queue', 'queue.json', '--handler', join(root, 'handler.mjs'), '--providers', join(root, providers)], { encoding: 'utf8' });
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
