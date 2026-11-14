import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runQueue } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { createWorktreeManager } from '../../runtime/lib/worktree.mjs';
import { createIntakeProvider } from '../../runtime/lib/intake.mjs';
import { createShadowGitHub, createShadowProvider, diffDecisions, writeShadowCycle } from '../../runtime/lib/shadow.mjs';

const RTD = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
const ROUTING = fileURLToPath(new URL('./routing-fixture.json', import.meta.url));
// Runtime lock records live in a private anchor, never in the work root.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-shadow-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const ADMISSIBLE = '## Goal\nFixture task.\n\n## Acceptance criteria\nRun: `node --test test/runtime/shadow.test.mjs`; Expected: exit 0.\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 10\nFiles: 1';
const handler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rt-shadow-'));
  const repo = join(root, 'repo'), workRoot = join(root, 'work');
  await mkdir(repo); await mkdir(workRoot);
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-b', 'main'); await writeFile(join(repo, 'file'), 'fixture'); git('add', 'file');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  return { root, repo, workRoot };
}

// A live tracker double that counts every call, reads included.
function countingClient(issue) {
  const calls = [];
  const record = (name, fn) => async (...args) => { calls.push(name); return fn(...args); };
  const client = {
    listComments: record('listComments', async () => issue.comments),
    listOpenPullRequests: record('listOpenPullRequests', async () => []),
    getPullRequest: record('getPullRequest', async () => ({ state: 'open' })),
    createIssue: record('createIssue', async () => ({ number: 99 })),
    addLabel: record('addLabel', async () => {}),
    removeLabel: record('removeLabel', async () => {}),
    createComment: record('createComment', async () => {}),
    squashMerge: record('squashMerge', async () => ({ mergeCommit: 'a'.repeat(40) })),
    closePullRequest: record('closePullRequest', async () => {}),
  };
  return { client, calls };
}

// A stale durable `working` issue: the daemon resumes it without a claim, so a full cycle runs to `done`.
async function resumedCycle({ root, repo, workRoot, githubClient }) {
  const issue = { id: '14', number: 14, state: 'OPEN', author: { login: 'owner' }, title: '[A] resume', body: ADMISSIBLE, createdAt: '2020-01-01', labels: ['rt:running'], comments: [{ body: '<!-- rt:claim -->' }] };
  const queue = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue] }, { includeRunning: true });
  await (await createWorktreeManager({ repoRoot: repo, workRoot })).create('14');
  const store = await createStateStore({ workRoot, now: () => 1000 });
  await store.update('14', (s) => { s.status = 'working'; s.phase = 'testing'; s.checkpoint = { phase: 'developing', at: 1 }; s.lease = { owner: 'previous', expiresAt: 1 }; s.heartbeatAt = 1; });
  return runQueue({ workRoot, repoRoot: repo, githubClient, queue, now: () => 1000000, handler });
}

test('a shadow GitHub client forwards reads and turns every write into a recorded no-op without touching the live client', async () => {
  const issue = { comments: [{ body: 'x' }] };
  const { client, calls } = countingClient(issue);
  const attempted = [];
  const shadow = createShadowGitHub(client, attempted);
  assert.deepEqual(await shadow.listComments(14), issue.comments);
  for (const name of ['createIssue', 'addLabel', 'removeLabel', 'createComment', 'squashMerge', 'closePullRequest']) {
    assert.equal(await shadow[name](1, 'x'), undefined);
  }
  assert.deepEqual(calls, ['listComments']);
  assert.deepEqual(attempted, ['createIssue', 'addLabel', 'removeLabel', 'createComment', 'squashMerge', 'closePullRequest']);
});

test('an unknown GitHub method is fenced, not forwarded', async () => {
  let called = false;
  const attempted = [];
  const shadow = createShadowGitHub({ deleteRepository: async () => { called = true; } }, attempted);
  assert.equal(await shadow.deleteRepository(), undefined);
  assert.equal(called, false);
  assert.deepEqual(attempted, ['deleteRepository']);
});

test('a read-only provider wrapper fences every method it is given', async () => {
  let called = false;
  const attempted = [];
  const git = createShadowProvider({ createRevert: async () => { called = true; } }, new Set(), attempted);
  assert.equal(await git.createRevert({}), undefined);
  assert.equal(called, false);
  assert.deepEqual(attempted, ['createRevert']);
});

test('a queue with one claimable issue completes a shadow cycle, writes its diff, and makes zero write calls', async () => {
  const { root, repo, workRoot } = await fixture();
  try {
    const issue = { id: '21', number: 21, state: 'OPEN', author: { login: 'owner' }, title: '[A] new', body: ADMISSIBLE, createdAt: '2020-01-01', labels: [{ name: 'type:feature' }], comments: [] };
    const { client, calls } = countingClient(issue);
    const attempted = [];
    const queue = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue] }, {});
    const result = await runQueue({ workRoot, repoRoot: repo, githubClient: createShadowGitHub(client, attempted), queue, now: () => 1000000, handler });
    assert.equal(result.outcomes[0].status, 'done');
    assert.ok(attempted.includes('addLabel'));
    assert.deepEqual(calls.filter((name) => !['listComments', 'listOpenPullRequests', 'getPullRequest'].includes(name)), []);
    await writeShadowCycle({ workRoot, outcomes: result.outcomes, live: {} });
    assert.equal(await readFile(join(workRoot, 'shadow', 'cycle-1.jsonl'), 'utf8'), '{"issue":"21","shadow":"done","live":null}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('identical decisions give an empty diff; a differing live decision gives one entry; a missing live decision is null', () => {
  assert.deepEqual(diffDecisions({ 14: 'done', 15: 'wait' }, { 14: 'done', 15: 'wait' }), []);
  assert.deepEqual(diffDecisions({ 14: 'done' }, { 14: 'wait' }), [{ issue: '14', shadow: 'done', live: 'wait' }]);
  assert.deepEqual(diffDecisions({ 14: 'done' }, {}), [{ issue: '14', shadow: 'done', live: null }]);
});

test('a full shadow cycle makes zero write calls and emits a diff for each live decision that differs', async () => {
  const { root, repo, workRoot } = await fixture();
  try {
    const issue = { comments: [{ body: '<!-- rt:claim -->' }] };
    const { client, calls } = countingClient(issue);
    const result = await resumedCycle({ root, repo, workRoot, githubClient: createShadowGitHub(client) });
    assert.equal(result.outcomes[0].status, 'done');
    assert.deepEqual(calls.filter((name) => name !== 'listComments'), []);

    const outcomes = result.outcomes;
    const differing = await writeShadowCycle({ workRoot, outcomes, live: { 14: 'wait' } });
    assert.deepEqual(differing.diff, [{ issue: '14', shadow: 'done', live: 'wait' }]);
    assert.equal(await readFile(join(workRoot, 'shadow', 'cycle-1.jsonl'), 'utf8'), '{"issue":"14","shadow":"done","live":"wait"}\n');

    const identical = await writeShadowCycle({ workRoot, outcomes, live: { 14: 'done' } });
    assert.deepEqual(identical.diff, []);
    assert.equal(await readFile(join(workRoot, 'shadow', 'cycle-2.jsonl'), 'utf8'), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the GitHub CLI runs shadow by default: a write attempt is a no-op and never reaches gh', async () => {
  const { root, repo, workRoot } = await fixture();
  const bin = join(root, 'bin');
  const log = join(root, 'gh.log');
  try {
    // A fake gh that answers the reads with an admissible, unclaimed issue and records every invocation.
    await mkdir(bin);
    const issue = { id: '21', number: 21, state: 'OPEN', author: { login: 'owner' }, title: '[A] new', body: ADMISSIBLE, createdAt: '2020-01-01', labels: [{ name: 'type:feature' }], comments: [] };
    const answers = { 'repo view': { owner: { login: 'owner' } }, 'issue list': [issue], 'issue view': { comments: [], state: 'OPEN', labels: [] }, 'pr list': [] };
    await writeFile(join(bin, 'gh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const answers = ${JSON.stringify(answers)};
const key = args.slice(0, 2).join(' ');
if (!(key in answers)) { console.error('unexpected gh call'); process.exit(1); }
console.log(JSON.stringify(answers[key]));
`);
    await chmod(join(bin, 'gh'), 0o755);
    const providers = join(root, 'providers.mjs');
    const handlerPath = join(root, 'handler.mjs');
    await writeFile(handlerPath, 'export default async () => ({ exitCode: 0, output: "ok" });\n');
    await writeFile(providers, `const stub = () => { throw new Error('not reached in shadow'); };
export default {
  context: { get: stub }, gates: { gate0: stub, reviewer: stub, crossCheck: stub },
  github: { getPullRequest: stub, requiredGreen: stub, squashMerge: stub, addLabel: stub, recordedEscalationApproval: stub, mainStatus: stub, openRevertPullRequest: stub, createIssue: stub, createComment: stub },
  git: { createRevert: stub },
  observation: { issue: { get: stub }, worktree: { inspect: stub }, git: { head: stub, commit: stub }, evidence: { checks: stub, review: stub } },
};
`);
    const child = spawn(process.execPath, [RTD, '--work-root', workRoot, '--github', '--repo', 'owner/repo', '--repo-root', repo, '--handler', handlerPath, '--providers', providers, '--routing', ROUTING],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, stderr);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls.length > 0);
    assert.deepEqual(calls.filter((args) => !['repo view', 'issue list', 'issue view', 'pr list'].includes(args.slice(0, 2).join(' '))), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
