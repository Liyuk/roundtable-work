import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';

// Locks live in a private anchor, never in the work root (same arrangement as daemon-workers.test.mjs).
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const scratch = join(process.cwd(), '.roundtable/scratch/86-fix2/tmp');
const tmp = async () => { await mkdir(scratch, { recursive: true }); return mkdtemp(join(scratch, 'case-')); };
const MODELS = { reviewer: 'model-review-strong', crossCheck: 'model-crosscheck' };
const PASS = '审查结论：通过';
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
      getPullRequest: async () => ({ body: 'Closes #53', state: 'open', draft: false, mergeable: true, head: head(), files: ['runtime/rtd.mjs'], ownerLogin: 'owner', comments: [] }),
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

/** A stacked pull request 90 on top of upstream 89: the live body names the upstream, the upstream state is injected. */
function stacked(w, upstream) {
  const github = w.autoMerge.github;
  const live = github.getPullRequest;
  const setBases = [];
  github.setBase = async (pr, base) => { setBases.push([pr, base]); };
  github.getPullRequest = async (n) => (n === 89 ? { state: upstream } : { ...(await live(n)), body: 'Stacked on #89\nCloses #53' });
  return { setBases };
}

test('a stacked pull request whose upstream is open is held: not retargeted, not merged', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const w = world(join(workRoot, 'worktrees', '53'));
  const s = stacked(w, 'open');
  const result = await pass({ root: { workRoot }, repo, issue: issueFor('53'), autoMerge: w.autoMerge, observationClients: w.observationClients });
  assert.equal(result.outcomes[0].merged, undefined);
  assert.equal(w.squashes.length, 0);
  assert.deepEqual(s.setBases, []);
});

test('a stacked pull request whose upstream closed without merge is never retargeted or merged', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const w = world(join(workRoot, 'worktrees', '53'));
  const s = stacked(w, 'closed');
  const result = await pass({ root: { workRoot }, repo, issue: issueFor('53'), autoMerge: w.autoMerge, observationClients: w.observationClients });
  assert.equal(result.outcomes[0].merged, undefined);
  assert.equal(w.squashes.length, 0);
  assert.deepEqual(s.setBases, []);
});

test('a stacked pull request whose upstream merged is retargeted to main, caught up by merge, then merged', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const worktree = join(workRoot, 'worktrees', '53');
  const w = world(worktree);
  const s = stacked(w, 'merged');
  const result = await pass({ root: { workRoot }, repo, issue: issueFor('53'), autoMerge: w.autoMerge, observationClients: w.observationClients });
  assert.equal(result.outcomes[0].merged, true);
  assert.deepEqual(s.setBases, [[90, 'main']]);
  assert.equal(w.squashes.length, 1);
});

/** One queue pass with no GitHub client: the queue is local, so no worktree is ever attached to the item. */
function localPass({ root, repo, issue, autoMerge, observationClients }) {
  return runQueue({ workRoot: root.workRoot, repoRoot: repo, queue: [issue], autoMerge, observationClients, models: MODELS, handler });
}

for (const upstream of ['open', 'closed']) {
  test(`without a GitHub client, a stacked pull request whose upstream is ${upstream} is held before any squash`, async () => {
    const { root, repo, workRoot } = await fixture();
    cleanup.push(root);
    const w = world(repo);
    const s = stacked(w, upstream);
    const result = await localPass({ root: { workRoot }, repo, issue: issueFor('53'), autoMerge: w.autoMerge, observationClients: w.observationClients });
    assert.match(result.outcomes[0].reason, /^stack: pull request #90 waits/);
    assert.equal(w.squashes.length, 0);
    assert.deepEqual(s.setBases, []);
  });
}

test('without a GitHub client, a stacked pull request whose upstream merged proceeds to merge', async () => {
  const { root, repo, workRoot } = await fixture();
  cleanup.push(root);
  const w = world(repo);
  stacked(w, 'merged');
  const result = await localPass({ root: { workRoot }, repo, issue: issueFor('53'), autoMerge: w.autoMerge, observationClients: w.observationClients });
  assert.equal(result.outcomes[0].merged, true);
  assert.equal(w.squashes.length, 1);
});
