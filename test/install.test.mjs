import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const install = (...args) => JSON.parse(execFileSync(process.execPath, [installer, ...args, '--json'], { encoding: 'utf8' }));
const workspace = (t) => {
  const target = mkdtempSync(join(tmpdir(), 'rtw-install-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  return target;
};

test('dry run plans the install but writes nothing', (t) => {
  const target = workspace(t);
  const result = install('--target', target, '--dry-run');
  assert.equal(result.dryRun, true);
  assert.ok(result.summary.create > 0);
  assert.equal(existsSync(join(target, '.roundtable')), false);
  assert.equal(existsSync(join(target, '.claude')), false);
});

test('installs a self-contained skill for both harnesses plus config', (t) => {
  const target = workspace(t);
  install('--target', target);
  for (const dir of ['.claude/skills/roundtable-work', '.agents/skills/roundtable-work']) {
    for (const file of ['SKILL.md', 'prompts/shared.md', 'prompts/roles/chief.md', 'templates/checkpoint.md', 'references/harnesses.md']) {
      assert.ok(existsSync(join(target, dir, file)), `${dir}/${file}`);
    }
  }
  assert.match(readFileSync(join(target, '.claude/agents/rt-reviewer.md'), 'utf8'), /^---\nname: rt-reviewer\n/);
  for (const file of ['team.md', 'policy.md', 'install.json']) assert.ok(existsSync(join(target, '.roundtable', file)));
  for (const dir of ['tickets', 'state', 'memory']) assert.ok(existsSync(join(target, '.roundtable', dir)));
});

test('--harness codex installs only the Agent Skills directory', (t) => {
  const target = workspace(t);
  install('--target', target, '--harness', 'codex');
  assert.ok(existsSync(join(target, '.agents/skills/roundtable-work/SKILL.md')));
  assert.equal(existsSync(join(target, '.claude')), false);
});

test('rerunning is idempotent and never overwrites user policy', (t) => {
  const target = workspace(t);
  install('--target', target);
  const policy = join(target, '.roundtable/policy.md');
  writeFileSync(policy, '# my policy\n');
  const second = install('--target', target, '--update');
  assert.equal(second.summary.create ?? 0, 0);
  assert.equal(second.summary.update ?? 0, 0);
  assert.equal(readFileSync(policy, 'utf8'), '# my policy\n');
  assert.ok(second.actions.some((a) => a.op === 'skip' && a.to === policy));
});

test('edited skill files are kept unless --update is given', (t) => {
  const target = workspace(t);
  install('--target', target, '--harness', 'claude');
  const shared = join(target, '.claude/skills/roundtable-work/prompts/shared.md');
  writeFileSync(shared, 'local edit\n');
  install('--target', target, '--harness', 'claude');
  assert.equal(readFileSync(shared, 'utf8'), 'local edit\n');
  install('--target', target, '--harness', 'claude', '--update');
  assert.notEqual(readFileSync(shared, 'utf8'), 'local edit\n');
});

test('rejects missing target and unknown harness', (t) => {
  assert.equal(spawnSync(process.execPath, [installer]).status, 2);
  assert.equal(spawnSync(process.execPath, [installer, '--target', workspace(t), '--harness', 'cursor']).status, 1);
});

const sha = /^[0-9a-f]{40,64}$/;
const record = (target) => JSON.parse(readFileSync(join(target, '.roundtable/install.json'), 'utf8'));

test('install record names the source commit when run from a git checkout', (t) => {
  const target = workspace(t);
  install('--target', target);
  assert.match(record(target).sourceCommit, sha);
});

test('--update records the new source commit after the source changes', (t) => {
  const src = mkdtempSync(join(tmpdir(), 'rtw-src-'));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  for (const p of ['scripts', '.agents', 'package.json']) cpSync(join(root, p), join(src, p), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  const copyInstaller = join(src, 'scripts/install.mjs');
  const target = workspace(t);
  execFileSync(process.execPath, [copyInstaller, '--target', target]);
  const first = record(target).sourceCommit;
  assert.match(first, sha);
  appendFileSync(join(src, '.agents/skills/roundtable-work/SKILL.md'), '\n');
  git('commit', '-q', '-am', 'two');
  execFileSync(process.execPath, [copyInstaller, '--target', target, '--update']);
  assert.match(record(target).sourceCommit, sha);
  assert.notEqual(record(target).sourceCommit, first);
});

test('installer outside a git checkout records a null source commit', (t) => {
  const src = mkdtempSync(join(tmpdir(), 'rtw-nogit-'));
  t.after(() => rmSync(src, { recursive: true, force: true }));
  for (const p of ['scripts', '.agents', 'package.json']) cpSync(join(root, p), join(src, p), { recursive: true });
  const target = workspace(t);
  execFileSync(process.execPath, [join(src, 'scripts/install.mjs'), '--target', target]);
  assert.equal(record(target).sourceCommit, null);
});

test('package, lockfile and skill versions agree', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).version;
  const skill = readFileSync(join(root, '.agents/skills/roundtable-work/SKILL.md'), 'utf8').match(/^metadata:\n\s+version: "([^"]+)"/m)[1];
  assert.deepEqual([pkg, lock, skill], ['0.2.2', '0.2.2', '0.2.2']);
});
