import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const install = (...args) => JSON.parse(execFileSync(process.execPath, [installer, ...args, '--json'], { encoding: 'utf8' }));
const workspace = () => mkdtempSync(join(tmpdir(), 'rtw-install-'));

test('dry run plans the install but writes nothing', () => {
  const target = workspace();
  const result = install('--target', target, '--dry-run');
  assert.equal(result.dryRun, true);
  assert.ok(result.summary.create > 0);
  assert.equal(existsSync(join(target, '.roundtable')), false);
  assert.equal(existsSync(join(target, '.claude')), false);
});

test('installs a self-contained skill for both harnesses plus config', () => {
  const target = workspace();
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

test('--harness codex installs only the Agent Skills directory', () => {
  const target = workspace();
  install('--target', target, '--harness', 'codex');
  assert.ok(existsSync(join(target, '.agents/skills/roundtable-work/SKILL.md')));
  assert.equal(existsSync(join(target, '.claude')), false);
});

test('rerunning is idempotent and never overwrites user policy', () => {
  const target = workspace();
  install('--target', target);
  const policy = join(target, '.roundtable/policy.md');
  writeFileSync(policy, '# my policy\n');
  const second = install('--target', target, '--update');
  assert.equal(second.summary.create ?? 0, 0);
  assert.equal(second.summary.update ?? 0, 0);
  assert.equal(readFileSync(policy, 'utf8'), '# my policy\n');
  assert.ok(second.actions.some((a) => a.op === 'skip' && a.to === policy));
});

test('edited skill files are kept unless --update is given', () => {
  const target = workspace();
  install('--target', target, '--harness', 'claude');
  const shared = join(target, '.claude/skills/roundtable-work/prompts/shared.md');
  writeFileSync(shared, 'local edit\n');
  install('--target', target, '--harness', 'claude');
  assert.equal(readFileSync(shared, 'utf8'), 'local edit\n');
  install('--target', target, '--harness', 'claude', '--update');
  assert.notEqual(readFileSync(shared, 'utf8'), 'local edit\n');
});

test('rejects missing target and unknown harness', () => {
  assert.equal(spawnSync(process.execPath, [installer]).status, 2);
  assert.equal(spawnSync(process.execPath, [installer, '--target', workspace(), '--harness', 'cursor']).status, 1);
});
