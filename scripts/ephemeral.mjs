#!/usr/bin/env node
// Load Roundtable Work into a temp dir outside the target repo, run a command against the target, then remove the temp dir.
// Usage: node scripts/ephemeral.mjs --target <workspace> [--harness claude,codex] -- <command> [args...]
// The command runs with cwd=<workspace> and RT_HOME=<temp dir>. The temp dir holds the skill, the default .roundtable/
// config and state, plus runtime/ and scripts/ copies. It is removed on exit, including failures. Git worktree metadata
// the command may have added to the target is pruned once its directories are gone.
import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { apply, exists, harnessDirs, plan } from './install.mjs';

const root = resolve(import.meta.dirname, '..');
const usage = 'usage: node scripts/ephemeral.mjs --target <workspace> [--harness claude,codex] -- <command> [args...]';

async function main() {
  const { values, positionals: [command, ...args] } = parseArgs({
    options: { target: { type: 'string' }, harness: { type: 'string', default: 'claude,codex' } },
    allowPositionals: true,
  });
  if (!values.target || !command) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const target = resolve(values.target);
  if (!await exists(target) || !(await stat(target)).isDirectory()) throw new Error(`target is not a directory: ${target}`);
  const harnesses = [...new Set(values.harness.split(',').map((h) => h.trim()).filter(Boolean))];
  const unknown = harnesses.filter((h) => !harnessDirs[h]);
  if (unknown.length || !harnesses.length) throw new Error(`unknown harness: ${unknown.join(', ') || '(none)'}; use claude and/or codex`);
  const tmp = await realpath(tmpdir());
  const realTarget = await realpath(target);
  if (tmp === realTarget || tmp.startsWith(realTarget + sep)) throw new Error(`temp dir must be outside the target: ${tmp}`);

  const home = await mkdtemp(join(tmp, 'rtw-ephemeral-'));
  let code;
  try {
    const { actions } = await plan({ target: home, harnesses, update: false });
    await apply(actions);
    for (const dir of ['runtime', 'scripts']) await cp(join(root, dir), join(home, dir), { recursive: true });
    await cp(join(root, 'package.json'), join(home, 'package.json'));
    const child = spawn(command, args, { cwd: target, env: { ...process.env, RT_HOME: home }, stdio: 'inherit' });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    code = await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', (status) => done(status ?? 1));
    });
  } finally {
    await rm(home, { recursive: true, force: true });
    spawnSync('git', ['-C', target, 'worktree', 'prune'], { stdio: 'ignore' });
  }
  process.exitCode = code;
}

main().catch((error) => {
  console.error(`ephemeral: ${error.message}`);
  process.exitCode = 1;
});
