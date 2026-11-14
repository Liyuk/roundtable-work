import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ephemeral = fileURLToPath(new URL('../../scripts/ephemeral.mjs', import.meta.url));
const mk = (t, prefix, base = tmpdir()) => {
  const path = mkdtempSync(join(base, prefix));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
};
// Each test gets a private TMPDIR so "no leftover temp dir" can be checked without racing other tests.
const sandbox = (t) => {
  const tmp = mk(t, 'rtw-tmp-');
  const target = mk(t, 'rtw-target-');
  execFileSync('git', ['init', '-q'], { cwd: target });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: target });
  return { tmp, target, env: { ...process.env, TMPDIR: tmp } };
};
const gitStatus = (target) => execFileSync('git', ['status', '--porcelain'], { cwd: target, encoding: 'utf8' });
const run = (args, env) => spawnSync(process.execPath, [ephemeral, ...args], { encoding: 'utf8', env });
const node = (code) => [process.execPath, '-e', code];

test('materializes the skill, runtime and default config outside the target and removes it on success', (t) => {
  const { tmp, target, env } = sandbox(t);
  const check = `const fs = require('node:fs'); const h = process.env.RT_HOME;
    for (const f of ['runtime/rtd.mjs', 'scripts/install.mjs', 'package.json', '.roundtable/policy.md', '.roundtable/team.md', '.claude/skills/roundtable-work/SKILL.md', '.agents/skills/roundtable-work/SKILL.md']) if (!fs.existsSync(h + '/' + f)) throw new Error('missing ' + f);`;
  const result = run(['--target', target, '--', ...node(check)], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(tmp), []);
  assert.equal(gitStatus(target), '');
  for (const path of ['.roundtable', '.claude', '.agents']) assert.equal(existsSync(join(target, path)), false, path);
});

test('runs the command with the target as cwd and RT_HOME set', (t) => {
  const { target, env } = sandbox(t);
  const result = run(['--target', target, '--', ...node('console.log(process.cwd(), process.env.RT_HOME)')], env);
  assert.equal(result.status, 0, result.stderr);
  const [cwd, home] = result.stdout.trim().split(' ');
  assert.equal(cwd, target);
  assert.ok(home.startsWith(env.TMPDIR));
});

test('removes the temp dir when the command fails (injected exit 7)', (t) => {
  const { tmp, target, env } = sandbox(t);
  const result = run(['--target', target, '--', ...node('process.exit(7)')], env);
  assert.equal(result.status, 7);
  assert.deepEqual(readdirSync(tmp), []);
  assert.equal(gitStatus(target), '');
});

test('removes the temp dir when the command cannot be started', (t) => {
  const { tmp, target, env } = sandbox(t);
  const result = run(['--target', target, '--', 'rtw-no-such-command-272'], env);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(readdirSync(tmp), []);
});

test('refuses a temp dir inside the target and writes nothing', (t) => {
  const { target, env } = sandbox(t);
  const inside = join(target, 'tmp');
  mkdirSync(inside);
  const result = run(['--target', target, '--', ...node('process.exit(0)')], { ...env, TMPDIR: inside });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the target/);
  assert.deepEqual(readdirSync(inside), []);
});

test('rejects a missing target, a missing command, and an unknown harness', (t) => {
  const { target, env } = sandbox(t);
  assert.equal(run(['--', 'true'], env).status, 2);
  assert.equal(run(['--target', target], env).status, 2);
  assert.equal(run(['--target', target, '--harness', 'cursor', '--', 'true'], env).status, 1);
});
