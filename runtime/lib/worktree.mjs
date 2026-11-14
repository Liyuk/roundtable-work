import { mkdir, lstat, realpath } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { assertSafeId, createConfinement } from './paths.mjs';
import { acquireLock } from './lock.mjs';

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
    await execFile('git', ['-C', repoRoot, 'worktree', 'add', '-b', branch, path, baseBranch], { maxBuffer: 1024 * 1024 });
    return { path, branch, existing: false };
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

  return { workRoot: confinement.root, repoRoot, pathFor, list, create, acquire, inspect };
}
