import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { createClaimCoordinator } from '../../runtime/lib/claim.mjs';
import { runWorkers } from '../../runtime/lib/workers.mjs';
import { createWorktreeManager } from '../../runtime/lib/worktree.mjs';
const scratch = join(process.cwd(), '.roundtable/scratch/94-dev-1/tmp');
const temp = async () => { await mkdir(scratch, { recursive: true }); return mkdtemp(join(scratch, 'workers-')); };
// Issue-lock records live in the private anchor (RTW_STATE_DIR, inherited by the child process below).
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

test('claim ticks add one running label and one marker comment, then resume stale orphan without reclaiming', async () => {
  const root = await temp();
  try {
    const events = [];
    const issue = { number: 7, title: '[RT] work', body: '', labels: [], comments: [] };
    const client = {
      addLabel: async (n, label) => { events.push(['label', n, label]); issue.labels.push(label); },
      createComment: async (n, body) => { events.push(['comment', n, body]); issue.comments.push({ body }); },
      listComments: async () => issue.comments,
    };
    let state = { status: 'queued', heartbeatAt: null, lease: null };
    let resumes = 0;
    const coordinator = createClaimCoordinator({ client, stateRoot: root, loadState: async () => state, isStale: async () => true, resume: async () => { resumes++; } });
    assert.equal((await coordinator.tick([issue])).claimed, 1);
    assert.equal((await coordinator.tick([issue])).claimed, 0);
    assert.equal(events.filter(([kind]) => kind === 'comment').length, 1);
    state = { status: 'working', heartbeatAt: 1, lease: { expiresAt: 1 } };
    issue.labels.push('rt:running');
    const held = createClaimCoordinator({ client, stateRoot: root, loadState: async () => state, isStale: async () => true, isInFlight: async () => true, resume: async () => { resumes++; } });
    assert.equal((await held.tick([issue])).resumed, 0);
    assert.equal((await coordinator.tick([issue])).resumed, 1);
    assert.equal(resumes, 1);
    assert.equal(events.filter(([kind]) => kind === 'comment').length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worker scheduler caps concurrency and serializes same series and dependency neighbors', async () => {
  const root = await temp();
  try {
    let active = 0, peak = 0;
    const issues = [
      { id: '1', title: '[RT] one', series: 'RT', dependencies: [] },
      { id: '2', title: '[RT] two', series: 'RT', dependencies: [] },
      { id: '3', title: '[Pages] three', series: 'Pages', dependencies: ['1'] },
      { id: '4', title: '[I18N] four', series: 'I18N', dependencies: [] },
    ];
    const running = [];
    const dependent = (a, b) => (a.dependencies ?? []).includes(b.id) || (b.dependencies ?? []).includes(a.id);
    const result = await runWorkers({ issues, workRoot: root, workers: 2, run: async (issue) => {
      for (const other of running) {
        assert.notEqual(issue.series, other.series, 'same series did not overlap');
        assert.equal(dependent(issue, other), false, 'dependent issues did not overlap');
      }
      running.push(issue);
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      running.splice(running.indexOf(issue), 1);
    } });
    assert.equal(peak, 2);
    assert.equal(result.completed.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('worktree paths reject traversal outside configured root', async () => {
  const base = await temp();
  const root = join(base, 'work');
  await mkdir(root);
  try {
    const manager = await createWorktreeManager({ workRoot: root, repoRoot: base });
    await assert.rejects(manager.pathFor('../escape'), { code: 'RT_PATH_ESCAPE' });
    assert.equal(await manager.pathFor('12'), join(root, 'worktrees', '12'));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('issue locks are visible across processes and git worktrees are visible to a second manager', async () => {
  const base = await temp();
  const repo = join(base, 'repo'), workRoot = join(base, 'work');
  await mkdir(repo); await mkdir(workRoot);
  try {
    const init = spawnSync('git', ['-C', repo, 'init', '-b', 'main'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    await writeFile(join(repo, 'README.md'), 'fixture\n');
    spawnSync('git', ['-C', repo, 'add', 'README.md']);
    spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture']);
    const first = await createWorktreeManager({ workRoot, repoRoot: repo });
    const second = await createWorktreeManager({ workRoot, repoRoot: repo });
    const lock = await first.acquire('12', 'first');
    assert.equal(lock.acquired, true);
    const lockPath = join(workRoot, 'locks', '12.lock.d');
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(new URL('../../runtime/lib/lock.mjs', import.meta.url).href)}; const r = await acquireLock({ lockPath: ${JSON.stringify(lockPath)}, repoRoot: ${JSON.stringify(repo)}, owner: 'second-process' }); console.log(r.acquired);`], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'false');
    const probe = await second.inspect('12');
    assert.equal(probe.heldLock, true);
    await lock.release();
    await first.create('12');
    assert.deepEqual(await second.list(), await first.list());
    assert.equal((await second.inspect('12')).liveWorktree, true);
    let scheduled;
    const scheduledResult = await runWorkers({ issues: [{ id: '14', title: '[Pages] work' }], workRoot, worktreeManager: second, run: async (_issue, context) => { scheduled = context; } });
    assert.deepEqual(scheduledResult.completed, ['14']);
    assert.equal(scheduled.existingWorktree, false);
    assert.equal(scheduled.worktree, await second.pathFor('14'));
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('existing issue worktree is rejected when checked out on a different branch', async () => {
  const base = await temp();
  const repo = join(base, 'repo'), workRoot = join(base, 'work');
  await mkdir(repo); await mkdir(workRoot);
  try {
    const init = spawnSync('git', ['-C', repo, 'init', '-b', 'main'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    await writeFile(join(repo, 'README.md'), 'fixture\n');
    spawnSync('git', ['-C', repo, 'add', 'README.md']);
    const commit = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { encoding: 'utf8' });
    assert.equal(commit.status, 0, commit.stderr);
    const manager = await createWorktreeManager({ workRoot, repoRoot: repo });
    const branch = spawnSync('git', ['-C', repo, 'branch', 'stale'], { encoding: 'utf8' });
    assert.equal(branch.status, 0, branch.stderr);
    const path = await manager.pathFor('92');
    const stale = spawnSync('git', ['-C', repo, 'worktree', 'add', path, 'stale'], { encoding: 'utf8' });
    assert.equal(stale.status, 0, stale.stderr);
    await assert.rejects(manager.create('92'), /branch stale, expected rt\/92-pi/i);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('existing issue worktree is reused when checked out on the expected branch', async () => {
  const base = await temp();
  const repo = join(base, 'repo'), workRoot = join(base, 'work');
  await mkdir(repo); await mkdir(workRoot);
  try {
    const init = spawnSync('git', ['-C', repo, 'init', '-b', 'main'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    await writeFile(join(repo, 'README.md'), 'fixture\n');
    spawnSync('git', ['-C', repo, 'add', 'README.md']);
    const commit = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { encoding: 'utf8' });
    assert.equal(commit.status, 0, commit.stderr);
    const manager = await createWorktreeManager({ workRoot, repoRoot: repo });
    const created = await manager.create('92');
    assert.equal(created.branch, 'rt/92-pi');
    assert.equal(created.existing, false);
    assert.deepEqual(await manager.create('92'), { ...created, existing: true });
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('existing detached issue worktree is reattached to and reused on the expected branch', async () => {
  const base = await temp();
  const repo = join(base, 'repo'), workRoot = join(base, 'work');
  await mkdir(repo); await mkdir(workRoot);
  try {
    const init = spawnSync('git', ['-C', repo, 'init', '-b', 'main'], { encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    await writeFile(join(repo, 'README.md'), 'fixture\n');
    spawnSync('git', ['-C', repo, 'add', 'README.md']);
    const commit = spawnSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { encoding: 'utf8' });
    assert.equal(commit.status, 0, commit.stderr);
    const manager = await createWorktreeManager({ workRoot, repoRoot: repo });
    const created = await manager.create('94');
    const detached = spawnSync('git', ['-C', created.path, 'switch', '--detach', 'HEAD'], { encoding: 'utf8' });
    assert.equal(detached.status, 0, detached.stderr);

    assert.deepEqual(await manager.create('94'), { ...created, existing: true });
    const currentBranch = spawnSync('git', ['-C', created.path, 'branch', '--show-current'], { encoding: 'utf8' });
    assert.equal(currentBranch.status, 0, currentBranch.stderr);
    assert.equal(currentBranch.stdout.trim(), 'rt/94-pi');
  } finally { await rm(base, { recursive: true, force: true }); }
});
