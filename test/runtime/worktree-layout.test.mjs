import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createWorktreeManager } from '../../runtime/lib/worktree.mjs';
import { PathEscapeError } from '../../runtime/lib/paths.mjs';

const execFile = promisify(execFileCallback);
const git = (cwd, ...args) => execFile('git', ['-C', cwd, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
const exists = (p) => access(p).then(() => true, () => false);

const cleanup = [];
after(() => Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true }))));

/** A real repository with one commit on `main`, plus a separate work root. */
async function fixture() {
  const repoRoot = await mkdtemp(join(tmpdir(), 'rt-wt-repo-'));
  const workRoot = await mkdtemp(join(tmpdir(), 'rt-wt-work-'));
  cleanup.push(repoRoot, workRoot);
  await git(repoRoot, 'init', '--quiet', '-b', 'main');
  await writeFile(join(repoRoot, 'README.md'), 'initial\n');
  await git(repoRoot, 'add', 'README.md');
  await git(repoRoot, 'commit', '--quiet', '-m', 'initial');
  return { repoRoot, workRoot, manager: await createWorktreeManager({ workRoot, repoRoot }) };
}

const branchExists = (repoRoot, branch) => git(repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);

test('remove deletes a clean worktree and its merged branch after create', async () => {
  const { repoRoot, manager } = await fixture();
  const { path, branch } = await manager.create('311');
  assert.equal(path, join(manager.workRoot, 'worktrees', '311'));
  assert.equal(branch, 'rt/311-pi');

  const result = await manager.remove('311');

  assert.deepEqual(result, { removed: true, branchDeleted: true });
  assert.equal(await exists(path), false);
  assert.equal(await branchExists(repoRoot, branch), false);
});

test('remove is idempotent when the worktree is already gone', async () => {
  const { manager } = await fixture();
  await manager.create('311');
  await manager.remove('311');

  const again = await manager.remove('311');

  assert.deepEqual(again, { removed: false, reason: 'absent' });
});

test('remove refuses a dirty worktree and deletes nothing', async () => {
  const { repoRoot, manager } = await fixture();
  const { path, branch } = await manager.create('311');
  await writeFile(join(path, 'scratch.txt'), 'uncommitted\n');

  const result = await manager.remove('311');

  assert.deepEqual(result, { removed: false, reason: 'dirty' });
  assert.equal(await exists(join(path, 'scratch.txt')), true);
  assert.equal(await branchExists(repoRoot, branch), true);
});

test('remove rejects an id that escapes the worktrees root before any git command runs', async () => {
  const { manager } = await fixture();

  await assert.rejects(manager.remove('../escape'), PathEscapeError);
  await assert.rejects(manager.remove('a/b'), PathEscapeError);
});
