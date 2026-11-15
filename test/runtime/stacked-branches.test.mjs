import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeOne, nextMergeable, retargetAndMerge } from '../../runtime/lib/merge-order.mjs';
import { syncWithBase } from '../../runtime/lib/worktree.mjs';

// Real local git: a bare `origin`, one clone per PR branch, and a fake GitHub client that squash-merges into main.
const env = { ...process.env, GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.invalid', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.invalid' };
const git = (dir, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-C', dir, ...args], { env, encoding: 'utf8' }).trim();
const isAncestor = (dir, older, newer) => execFileSync('git', ['-C', dir, 'merge-base', '--is-ancestor', older, newer], { env }) && true;

const roots = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stacked-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'base'); git(seed, 'push', '-q', 'origin', 'main');
  return { root, origin, seed };
}
test.after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// Create a PR branch `name` on top of `from` (a ref on origin) with one new file, and push it to origin.
function branchOn({ root, origin }, name, from, file, text) {
  const dir = join(root, name.replace('/', '-'));
  git(root, 'clone', '-q', origin, dir);
  git(dir, 'checkout', '-q', '-b', name, from);
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', name);
  git(dir, 'push', '-q', 'origin', `HEAD:refs/heads/${name}`);
  return dir;
}

function fakeGitHub({ root, origin }) {
  const landing = join(root, 'landing');
  git(root, 'clone', '-q', origin, landing);
  const gh = {
    prs: [],
    merged: new Set(),
    calls: [],
    find(n) { return gh.prs.find((pr) => pr.number === n); },
    async setBase(n, base) { gh.calls.push(['setBase', n, base]); gh.find(n).base = base; },
    headOf(n) { return git(origin, 'rev-parse', `refs/heads/${gh.find(n).branch}`); },
    squashMerge(n) {
      git(landing, 'fetch', '-q', 'origin');
      git(landing, 'checkout', '-q', '-B', 'main', 'origin/main');
      git(landing, 'merge', '--squash', '-q', `origin/${gh.find(n).branch}`);
      git(landing, 'commit', '-q', '-m', `squash #${n}`);
      git(landing, 'push', '-q', 'origin', 'main');
      gh.merged.add(n);
      gh.calls.push(['squash', n]);
    },
  };
  return gh;
}

// The real catch-up steps: merge origin/<base> (never rebase or force), normal push, head read.
function gitFor(dir, branch) {
  return {
    async mergeBase(base) {
      git(dir, 'fetch', '-q', 'origin', base);
      const before = git(dir, 'rev-parse', 'HEAD');
      try { git(dir, 'merge', '--no-edit', '-q', `origin/${base}`); } catch { return 'conflict'; }
      return git(dir, 'rev-parse', 'HEAD') === before ? 'up-to-date' : 'clean';
    },
    async mergeAbort() { git(dir, 'merge', '--abort'); },
    async push() { git(dir, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`); },
    async head() { return git(dir, 'rev-parse', 'HEAD'); },
  };
}

// Land one PR the way the runtime does: a downstream is retargeted first, an upstream-less PR goes straight to mergeOne.
async function land({ gh, dir, pr, checks }) {
  const args = {
    issue: String(pr.number), pr: pr.number, base: 'main', git: gitFor(dir, pr.branch),
    checks: { async run(head) { checks.push(head); return true; } },
    merge: async ({ pr: n, head }) => {
      if (gh.headOf(n) !== head) return false;
      gh.squashMerge(n);
      return true;
    },
    cleanup: async () => {},
  };
  return pr.body.includes('Stacked on') ? retargetAndMerge({ github: gh, ...args }) : mergeOne(args);
}

test('three-layer chain: B retargets to main and catches up by merge, then C follows after B merges', async () => {
  const fx = fixture();
  const gh = fakeGitHub(fx);
  const a = branchOn(fx, 'rt/A', 'origin/main', 'a.txt', 'a\n');
  const b = branchOn(fx, 'rt/B', 'origin/rt/A', 'b.txt', 'b\n');
  const c = branchOn(fx, 'rt/C', 'origin/rt/B', 'c.txt', 'c\n');
  gh.prs.push({ number: 61, branch: 'rt/A', base: 'main', body: '' });
  gh.prs.push({ number: 62, branch: 'rt/B', base: 'rt/A', body: 'Stacked on #61' });
  gh.prs.push({ number: 63, branch: 'rt/C', base: 'rt/B', body: 'Stacked on #62' });
  const dirs = { 61: a, 62: b, 63: c };
  const checks = [];

  const order = [];
  for (let i = 0; i < 3; i++) {
    const pr = nextMergeable(gh.prs.filter((p) => !gh.merged.has(p.number)), gh.merged);
    order.push(pr.number);
    const before = gh.headOf(pr.number);
    const result = await land({ gh, dir: dirs[pr.number], pr, checks });
    assert.deepEqual(result, { merged: true });
    const after = gh.headOf(pr.number);
    if (pr.number !== 61) {
      // No force: the pre-catch-up head is an ancestor of the pushed head, which is a merge commit.
      assert.equal(isAncestor(fx.origin, before, after), true);
      assert.equal(git(fx.origin, 'rev-list', '--parents', '-n1', after).split(' ').length, 3);
      assert.ok(checks.includes(after), `checks ran on the new head of #${pr.number}`);
    }
  }

  assert.deepEqual(order, [61, 62, 63]);
  assert.deepEqual(gh.calls.filter((c) => c[0] === 'setBase'), [['setBase', 62, 'main'], ['setBase', 63, 'main']]);
  assert.deepEqual([...gh.merged], [61, 62, 63]);
  assert.equal(git(fx.origin, 'show', 'refs/heads/main:c.txt'), 'c');
});

test('a catch-up conflict stops with nothing pushed, nothing checked and nothing merged', async () => {
  const fx = fixture();
  const gh = fakeGitHub(fx);
  const a = branchOn(fx, 'rt/A', 'origin/main', 'a.txt', 'a\n');
  const b = branchOn(fx, 'rt/B', 'origin/rt/A', 'shared.txt', 'branch side\n');
  gh.prs.push({ number: 61, branch: 'rt/A', base: 'main', body: '' });
  gh.prs.push({ number: 62, branch: 'rt/B', base: 'rt/A', body: 'Stacked on #61' });
  const checks = [];

  await land({ gh, dir: a, pr: gh.prs[0], checks });
  checks.length = 0;
  // main changes the same file differently after B branched: B's catch-up conflicts.
  git(fx.seed, 'pull', '-q', 'origin', 'main');
  writeFileSync(join(fx.seed, 'shared.txt'), 'main side\n');
  git(fx.seed, 'add', '-A'); git(fx.seed, 'commit', '-q', '-m', 'main side'); git(fx.seed, 'push', '-q', 'origin', 'main');

  const before = gh.headOf(62);
  const result = await land({ gh, dir: b, pr: gh.prs[1], checks });
  assert.deepEqual(result, { stop: 'conflict' });
  assert.equal(gh.headOf(62), before, 'nothing pushed');
  assert.deepEqual(checks, [], 'checks never ran on the conflicting merge');
  assert.equal(gh.merged.has(62), false);
  assert.equal(git(b, 'status', '--porcelain'), '', 'the conflicting merge was aborted');
});

test('syncWithBase on a conflicting catch-up stops with the worktree clean, no merge in progress and nothing pushed', async () => {
  const fx = fixture();
  const path = join(fx.root, 'issue-86');
  git(fx.root, 'clone', '-q', fx.origin, path);
  git(path, 'checkout', '-q', '-b', 'rt/86-pi');
  writeFileSync(join(path, 'README.md'), 'branch side\n');
  git(path, 'commit', '-q', '-am', 'branch side');
  git(path, 'push', '-q', 'origin', 'HEAD:refs/heads/rt/86-pi');
  const before = git(fx.origin, 'rev-parse', 'refs/heads/rt/86-pi');
  // main changes the same line after the issue branched: the catch-up conflicts.
  writeFileSync(join(fx.seed, 'README.md'), 'main side\n');
  git(fx.seed, 'commit', '-q', '-am', 'main side'); git(fx.seed, 'push', '-q', 'origin', 'main');

  assert.deepEqual(await syncWithBase({ path, id: '86', base: 'main' }), { stop: 'conflict' });
  assert.equal(git(path, 'status', '--porcelain'), '');
  assert.throws(() => git(path, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
  assert.equal(git(fx.origin, 'rev-parse', 'refs/heads/rt/86-pi'), before, 'nothing pushed');
});
