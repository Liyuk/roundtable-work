/**
 * Layout (fixed; do not change):
 *   <workRoot>/worktrees/<id>   git worktree of the repository, checked out on branch `rt/<id>-pi`
 *   <workRoot>/locks/<id>.lock.d  per-issue lock directory
 * `<id>` must pass assertSafeId (see paths.mjs); `remove` never uses `--force` and only deletes a branch merged into baseBranch.
 */
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { assertSafeId, createConfinement } from './paths.mjs';
import { acquireLock } from './lock.mjs';
import { mergeOne, retargetAndMerge } from './merge-order.mjs';

const execFile = promisify(execFileCallback);

/** Manage issue worktrees and locks beneath a configured work root. */
export async function createWorktreeManager({ workRoot, repoRoot, baseBranch = 'main', now = Date.now, lockTtlMs = 60_000 }) {
  const confinement = await createConfinement(workRoot);
  const worktrees = await confinement.resolve('worktrees');
  const locks = await confinement.resolve('locks');
  await mkdir(worktrees, { recursive: true, mode: 0o700 });
  await mkdir(locks, { recursive: true, mode: 0o700 });

  const pathFor = async (rawId) => {
    const id = assertSafeId(rawId);
    return confinement.resolve('worktrees', id);
  };

  // `git worktree list` reports resolved (symlink-free) paths; compare against the resolved form of the worktrees root.
  const realPathFor = async (id) => join(await realpath(worktrees), id);

  async function list() {
    const { stdout } = await execFile('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { maxBuffer: 1024 * 1024 });
    return stdout.split(/\r?\n/).filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
  }

  async function create(rawId) {
    const id = assertSafeId(rawId);
    const path = await pathFor(id);
    const branch = `rt/${id}-pi`;
    const existing = await list();
    if (existing.includes(await realPathFor(id))) {
      const { stdout } = await execFile('git', ['-C', path, 'branch', '--show-current'], { maxBuffer: 1024 * 1024 });
      const checkedOutBranch = stdout.trim();
      if (checkedOutBranch !== branch) {
        if (!checkedOutBranch) {
          try {
            await execFile('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { maxBuffer: 1024 * 1024 });
            const [{ stdout: detachedHead }, { stdout: branchHead }] = await Promise.all([
              execFile('git', ['-C', path, 'rev-parse', 'HEAD'], { maxBuffer: 1024 * 1024 }),
              execFile('git', ['-C', repoRoot, 'rev-parse', `refs/heads/${branch}`], { maxBuffer: 1024 * 1024 }),
            ]);
            if (detachedHead.trim() === branchHead.trim()) {
              await execFile('git', ['-C', path, 'switch', branch], { maxBuffer: 1024 * 1024 });
              return { path, branch, existing: true };
            }
          } catch (error) {
            if (error.cmd?.includes('switch')) {
              throw new Error(`Unable to reattach existing detached worktree at ${path} to expected branch ${branch}: ${error.stderr?.trim() || error.message}`, { cause: error });
            }
          }
        }
        throw new Error(`Existing worktree at ${path} is on branch ${checkedOutBranch || '(detached HEAD)'}, expected ${branch}`);
      }
      return { path, branch, existing: true };
    }
    await confinement.resolve('worktrees', id);
    // A branch kept by an earlier `remove` (unmerged work) is reused as-is so its commits survive.
    const branchKept = await execFile('git', ['-C', repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { maxBuffer: 1024 * 1024 }).then(() => true, () => false);
    const args = branchKept ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, baseBranch];
    await execFile('git', ['-C', repoRoot, ...args], { maxBuffer: 1024 * 1024 });
    return { path, branch, existing: false };
  }

  /**
   * Remove the worktree for `id` and, when its branch is merged into baseBranch, the branch too.
   * Returns `{ removed: false, reason: 'absent' }` when there is nothing to remove and
   * `{ removed: false, reason: 'dirty' }` when git refuses to remove the worktree.
   */
  async function remove(rawId) {
    const id = assertSafeId(rawId);
    const path = await pathFor(id);
    const branch = `rt/${id}-pi`;
    if (!(await list()).includes(await realPathFor(id))) return { removed: false, reason: 'absent' };
    try {
      await execFile('git', ['-C', repoRoot, 'worktree', 'remove', path], { maxBuffer: 1024 * 1024 });
    } catch {
      return { removed: false, reason: 'dirty' };
    }
    const merged = await execFile('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${baseBranch}`]).then(() => true, () => false);
    if (merged) await execFile('git', ['-C', repoRoot, 'branch', '-D', branch], { maxBuffer: 1024 * 1024 });
    return { removed: true, branchDeleted: merged };
  }

  async function acquire(rawId, owner = `worker-${process.pid}`) {
    const id = assertSafeId(rawId);
    return acquireLock({ lockPath: join(locks, `${id}.lock.d`), repoRoot, owner, now, ttlMs: lockTtlMs });
  }

  async function inspect(rawId) {
    const id = assertSafeId(rawId);
    const path = await pathFor(id);
    const worktreesForRepo = await list();
    const liveWorktree = worktreesForRepo.includes(await realPathFor(id)) && (await lstat(path).then((s) => s.isDirectory(), () => false));
    const lock = await acquire(rawId, `probe-${process.pid}-${id}`);
    if (lock.acquired) { await lock.release().catch(() => false); return { id, liveWorktree, heldLock: false }; }
    return { id, liveWorktree, heldLock: true, holder: lock.holder };
  }

  return { workRoot: confinement.root, repoRoot, pathFor, list, create, remove, acquire, inspect };
}

/**
 * Bring the issue branch of `id` up to `origin/<base>` before its gates run: merge, never rebase or force, and push
 * with a normal push, which git refuses unless it fast-forwards the remote branch. A conflicting merge is aborted and
 * returns `{ stop: 'conflict' }` with nothing pushed. A repository without an `origin` remote has no base to sync
 * with, so it is left as it is. The checks and merge steps of `mergeOne` are no-ops here: the gates run next.
 * With `github` and `pr` (a stacked pull request whose upstreams merged) the base is first set through `github.setBase`.
 */
export async function syncWithBase({ path, id, base, github, pr }) {
  const git = async (...args) => (await execFile('git', ['-C', path, ...args], { maxBuffer: 1024 * 1024 })).stdout.trim();
  if (!(await git('remote')).split('\n').includes('origin')) return {};
  const step = {
    issue: id, pr: null, base,
    git: {
      async mergeBase(name) {
        await git('fetch', '--quiet', 'origin', name);
        const before = await git('rev-parse', 'HEAD');
        try { await git('merge', '--no-edit', '--quiet', `origin/${name}`); } catch { return 'conflict'; }
        return (await git('rev-parse', 'HEAD')) === before ? 'up-to-date' : 'clean';
      },
      mergeAbort: () => git('merge', '--abort').catch(() => {}),
      push: () => git('push', '--quiet', 'origin', 'HEAD'),
      head: () => git('rev-parse', 'HEAD'),
    },
    checks: { run: async () => true }, merge: async () => true, cleanup: async () => {},
  };
  return github ? retargetAndMerge({ github, ...step, pr }) : mergeOne(step);
}
