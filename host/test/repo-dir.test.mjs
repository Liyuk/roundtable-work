// Repo dir resolution in the host scripts: RT_REPO_DIR when set, else $(dirname RT_HOME)/roundtable-work. No network; fake git/gh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = { rtWt: join(hostDir, 'bin', 'rt-wt'), rtRevert: join(hostDir, 'bin', 'rt-revert'), rtWork: join(hostDir, 'rt-work.sh') };

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-repodir-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Fake git logs its argv and fails, so the script stops right after the first `git -C <repo>`.
function fakeEnv(dir, repoDir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${join(dir, 'git.log')}"\nexit 1\n`);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'git'), 0o755); chmodSync(join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RT_HOME: join(dir, 'rt-loop'), RT_GH_REAL: join(bin, 'gh') };
  delete env.RT_REPO_DIR;
  if (repoDir !== undefined) env.RT_REPO_DIR = repoDir;
  return env;
}

// Shared setup for the two scripts that run for real: an empty config.env and one merges.log row for rt-revert.
function revertSandbox(dir) {
  mkdirSync(join(dir, 'rt-loop', 'state'), { recursive: true });
  writeFileSync(join(dir, 'rt-loop', 'config.env'), '');
  writeFileSync(join(dir, 'rt-loop', 'state', 'merges.log'), `${'a'.repeat(40)}\t1\t2\t${'a'.repeat(40)}\n`);
}

function firstGitRepo(dir) {
  return readFileSync(join(dir, 'git.log'), 'utf8').split('\n')[0].split(' ')[1];
}

for (const [name, script] of [['rt-wt', SCRIPTS.rtWt], ['rt-revert', SCRIPTS.rtRevert]]) {
  test(`${name}: RT_REPO_DIR wins when set`, (t) => {
    const dir = scratch(t);
    const env = fakeEnv(dir, join(dir, 'custom-repo'));
    revertSandbox(dir);
    spawnSync(script, name === 'rt-wt' ? ['613'] : ['a'.repeat(40)], { env });
    assert.equal(firstGitRepo(dir), join(dir, 'custom-repo'));
  });

  test(`${name}: unset RT_REPO_DIR resolves to $(dirname RT_HOME)/roundtable-work`, (t) => {
    const dir = scratch(t);
    const env = fakeEnv(dir, undefined);
    revertSandbox(dir);
    spawnSync(script, name === 'rt-wt' ? ['613'] : ['a'.repeat(40)], { env });
    assert.equal(firstGitRepo(dir), join(dir, 'roundtable-work'));
  });
}

// rt-work.sh is too heavy to run: evaluate its REPO_DIR line on its own.
const workLine = readFileSync(SCRIPTS.rtWork, 'utf8').split('\n').find((l) => l.startsWith('REPO_DIR='));

function evalRepoDir(dir, repoDir) {
  const env = { ...process.env, RT_HOME: join(dir, 'rt-loop') };
  delete env.RT_REPO_DIR;
  if (repoDir !== undefined) env.RT_REPO_DIR = repoDir;
  const r = spawnSync('bash', ['-c', `${workLine}\nprintf %s "$REPO_DIR"`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('rt-work.sh: RT_REPO_DIR wins when set', (t) => {
  const dir = scratch(t);
  assert.equal(evalRepoDir(dir, join(dir, 'custom-repo')), join(dir, 'custom-repo'));
});

test('rt-work.sh: unset RT_REPO_DIR resolves to $(dirname RT_HOME)/roundtable-work', (t) => {
  const dir = scratch(t);
  assert.equal(evalRepoDir(dir, undefined), join(dir, 'roundtable-work'));
});
