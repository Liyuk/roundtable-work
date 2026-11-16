import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { createWorktreeManager } from '../../runtime/lib/worktree.mjs';
import { createIntakeProvider } from '../../runtime/lib/intake.mjs';
import { buildPrRecord, upsertPrRecord } from '../../runtime/lib/pr-record.mjs';

// Locks live in a private anchor, never in the work root (same arrangement as daemon-workers.test.mjs).
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const scratch = join(process.cwd(), '.roundtable/scratch/55-r2-wire/tmp');
const tmp = async () => { await mkdir(scratch, { recursive: true }); return mkdtemp(join(scratch, 'case-')); };
const exists = (path) => access(path).then(() => true, () => false);
const MODELS = { reviewer: 'model-review-strong', crossCheck: 'model-crosscheck' };
const PASS = 'Verdict: pass';
const RATIONALE = 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.';
const ADMISSIBLE = '## Goal\nFixture task.\n\n## Acceptance criteria\nRun: `node --test test/runtime/rtd-cleanup.test.mjs`; Expected: exit 0.\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 10\nFiles: 1';

// Commit identity for the fixtures and for the merges the runtime makes (the base sync creates merge commits itself).
Object.assign(process.env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' });
const gitEnv = process.env;
/** Run git and return trimmed stdout; a non-zero exit is an error. */
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
const refExists = (cwd, ref) => spawnSync('git', ['-C', cwd, 'show-ref', '--verify', '--quiet', ref], { env: gitEnv }).status === 0;

/** A bare origin and a working repository on `main`, both at the same first commit. */
async function fixture() {
  const root = await tmp();
  const origin = join(root, 'origin.git'), repo = join(root, 'repo'), workRoot = join(root, 'work');
  await mkdir(repo); await mkdir(workRoot);
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(repo, 'init', '-b', 'main');
  await writeFile(join(repo, 'README.md'), 'initial\n');
  git(repo, 'add', 'README.md'); git(repo, 'commit', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', 'origin', 'main');
  return { root, origin, repo, workRoot };
}

/** Commit `text` to `file` on main in the repository and push it to origin; returns the new main SHA. */
async function advanceMain(repo, file, text) {
  await writeFile(join(repo, file), text);
  git(repo, 'add', file); git(repo, 'commit', '-m', `main: ${file}`); git(repo, 'push', 'origin', 'main');
  return git(repo, 'rev-parse', 'HEAD');
}

const issueFor = (id, extra = {}) => ({ id, number: Number(id), state: 'OPEN', author: { login: 'owner' }, title: `[A] issue ${id}`, body: ADMISSIBLE, labels: [], comments: [], ...extra });
function clientFor(issue) {
  return {
    addLabel: async (_n, label) => { issue.labels.push(label); },
    removeLabel: async (_n, label) => { issue.labels = issue.labels.filter((value) => value !== label); },
    createComment: async (_n, body) => { issue.comments.push({ body }); },
    listComments: async () => issue.comments,
  };
}

/** Gates and GitHub for the auto-merge step. The head is the issue worktree's HEAD, as a pull request head would be. */
function world(worktree, { ci = true } = {}) {
  const squashes = [], gateCalls = [];
  const state = { ci };
  const head = () => git(worktree, 'rev-parse', 'HEAD');
  // Observation reads the live worktree HEAD, as production does; a fixed SHA would fail the Gate 1 precondition.
  const observationClients = {
    expectedSha: async () => head(),
    issue: { get: async () => ({ state: 'open', labels: ['rt:running'] }) },
    worktree: { inspect: async () => ({ dirty: false }) },
    git: { head: async () => head(), commit: async () => ({ sha: head() }) },
    evidence: { checks: async () => ({ sha: head(), conclusion: 'success' }), review: async () => ({ sha: head(), conclusion: 'approved' }) },
  };
  const autoMerge = {
    context: async () => ({ pr: 90, head: head(), tree: 'tree1', highRisk: false, changedFiles: ['runtime/rtd.mjs'] }),
    gates: {
      gate0: async () => { gateCalls.push('gate0'); return true; },
      reviewer: async () => { gateCalls.push('gate1'); return { passed: true, head: head(), rationale: RATIONALE }; },
      crossCheck: async () => true,
    },
    github: {
      getPullRequest: async () => ({ state: 'open', body: upsertPrRecord('Closes #53', buildPrRecord({ issue: '53', head: head(), tree: 'tree1', passed: ['gate0', 'gate1', 'ci'] })), draft: false, mergeable: true, head: head(), files: ['runtime/rtd.mjs'], ownerLogin: 'owner', comments: [] }),
      requiredGreen: async () => (state.ci === true ? true : { green: false, status: state.ci }),
      squashMerge: async (_pr, options) => { squashes.push(options); return { mergeCommit: 'abcdef0123456789' }; },
      addLabel: async () => {},
      createComment: async () => {},
      recordedEscalationApproval: async () => null,
      mainStatus: async () => ({ head: 'abcdef0123456789', status: 'green' }),
      openRevertPullRequest: async () => { throw new Error('unexpected revert'); },
      createIssue: async () => { throw new Error('unexpected bug issue'); },
    },
  };
  return { autoMerge, observationClients, state, squashes, gateCalls };
}

const handler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' });

/** One queue pass for a single GitHub-tracked issue with the auto-merge step wired. */
function pass({ root, repo, issue, autoMerge, observationClients }) {
  return runQueue({ workRoot: root.workRoot, repoRoot: repo, githubClient: clientFor(issue), queue: [issue], autoMerge, observationClients, models: MODELS, handler });
}

const cleanup = [];
after(() => Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true }))));

test('a merged outcome removes the issue worktree', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const worktree = join(workRoot, 'worktrees', '53');
  const w = world(worktree);
  const result = await pass({ root: { workRoot }, repo, issue: issueFor('53'), autoMerge: w.autoMerge, observationClients: w.observationClients });
  assert.equal(result.outcomes[0].status, 'done');
  assert.equal(result.outcomes[0].merged, true);
  assert.equal(w.squashes.length, 1);
  assert.equal(await exists(worktree), false);
});

test('a waiting_external outcome keeps the issue worktree', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const worktree = join(workRoot, 'worktrees', '53');
  const w = world(worktree, { ci: 'pending' });
  const result = await pass({ root: { workRoot }, repo, issue: issueFor('53'), autoMerge: w.autoMerge, observationClients: w.observationClients });

  assert.equal(result.outcomes[0].status, 'waiting_external');
  assert.equal(await exists(worktree), true);
});

test('a cancelled issue has its worktree removed on the pass that finds it terminal', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const manager = await createWorktreeManager({ workRoot, repoRoot: repo });
  const { path } = await manager.create('54');
  await (await createStateStore({ workRoot })).update('54', (s) => { s.status = 'cancelled'; });

  const result = await runQueue({ workRoot, repoRoot: repo, githubClient: clientFor(issueFor('54')), queue: [issueFor('54')], handler });

  assert.deepEqual(result.outcomes, []);
  assert.equal(await exists(path), false);
});

test('a dirty worktree is kept and the refusal is logged, not thrown', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const manager = await createWorktreeManager({ workRoot, repoRoot: repo });
  const { path } = await manager.create('55');
  await writeFile(join(path, 'scratch.txt'), 'uncommitted\n');
  await (await createStateStore({ workRoot })).update('55', (s) => { s.status = 'cancelled'; });

  const logged = [];
  const original = console.error;
  console.error = (line) => logged.push(String(line));
  try {
    await runQueue({ workRoot, repoRoot: repo, githubClient: clientFor(issueFor('55')), queue: [issueFor('55')], handler });
  } finally { console.error = original; }

  assert.equal(await exists(join(path, 'scratch.txt')), true);
  assert.ok(logged.some((line) => line.includes('"event":"worktree_cleanup"') && line.includes('"reason":"dirty"')), logged.join('\n'));
});

test('the finalizing path syncs with origin/main before gates; a conflict fails closed and pushes nothing', async () => {
  const { root, origin, repo, workRoot } = await fixture();
  cleanup.push(root);
  const path = join(workRoot, 'worktrees', '53');
  const w = world(path);
  // The developer commits on the issue branch; main then changes the same line, so the base sync conflicts.
  const developer = async ({ phase, item }) => {
    if (phase === 'developing') {
      await writeFile(join(item.worktree, 'README.md'), 'branch side\n'); git(item.worktree, 'commit', '-am', 'branch side');
      await advanceMain(repo, 'README.md', 'main side\n');
    }
    return handler({ phase });
  };
  const issue = issueFor('53');
  const result = await runQueue({ workRoot, repoRoot: repo, githubClient: clientFor(issue), queue: [issue], autoMerge: w.autoMerge, observationClients: w.observationClients, models: MODELS, handler: developer });

  // Each conflict is a developer fix round; once that budget is spent the issue stops for Chief.
  assert.deepEqual([result.outcomes[0].status, result.outcomes[0].reason, result.outcomes[0].decision], ['stop', 'developer_budget_exhausted', 'stop']);
  assert.equal(w.squashes.length, 0);
  assert.equal(refExists(origin, 'refs/heads/rt/53-pi'), false, 'nothing pushed');
});

test('a clean sync pushes the merged base and gates and squash see the new head', async () => {
  const { root, origin, repo, workRoot } = await fixture();
  cleanup.push(root);
  const path = join(workRoot, 'worktrees', '53');
  const w = world(path);
  let newMain;
  // main moves while the developer works, so the finalizing sync has something to merge in (a clean merge).
  const developer = async ({ phase }) => {
    if (phase === 'developing') newMain = await advanceMain(repo, 'other.txt', 'main side\n');
    return handler({ phase });
  };
  const result = await runQueue({ workRoot, repoRoot: repo, githubClient: clientFor(issueFor('53')), queue: [issueFor('53')], autoMerge: w.autoMerge, observationClients: w.observationClients, models: MODELS, handler: developer });

  assert.equal(result.outcomes[0].status, 'done');
  assert.equal(git(origin, 'rev-parse', 'refs/heads/rt/53-pi'), newMain);
  assert.deepEqual(w.squashes, [{ method: 'squash', sha: newMain }]);
  assert.equal((await (await createStateStore({ workRoot })).load('53')).gateRecord.head, newMain);
});

test('a moved head re-runs the gates a held wake had already passed', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const worktree = join(workRoot, 'worktrees', '53');
  const issue = issueFor('53');
  const w = world(worktree, { ci: 'pending' });
  assert.equal((await pass({ root: { workRoot }, repo, issue, autoMerge: w.autoMerge, observationClients: w.observationClients })).outcomes[0].status, 'waiting_external');
  assert.deepEqual(w.gateCalls, ['gate0', 'gate1']);

  const newMain = await advanceMain(repo, 'other.txt', 'main side\n');
  w.state.ci = true;
  const second = await pass({ root: { workRoot }, repo, issue, autoMerge: w.autoMerge, observationClients: w.observationClients });

  assert.equal(second.outcomes[0].status, 'done');
  assert.deepEqual(w.gateCalls, ['gate0', 'gate1', 'gate0', 'gate1'], 'gates ran again for the moved head');
  assert.deepEqual(w.squashes, [{ method: 'squash', sha: newMain }]);
});

test('an issue whose dependency is still open is not admitted', async () => {
  const dependent = { number: 61, state: 'OPEN', author: { login: 'owner' }, title: '[A] dependent', createdAt: '2020-01-01', labels: [{ name: 'type:feature' }],
    body: ADMISSIBLE.replace('None.\n\n## Size', 'Depends on #60\n\n## Size') };
  const reader = (depState) => ({
    getOwner: async () => 'owner',
    listIssues: async () => [dependent],
    getIssue: async () => ({ state: depState }),
  });

  assert.deepEqual((await createIntakeProvider(reader('OPEN'))({})).map((item) => item.id), []);
  assert.deepEqual((await createIntakeProvider(reader('CLOSED'))({})).map((item) => item.id), ['61']);
});
