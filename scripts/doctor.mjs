import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exists, harnessDirs, skillSource, skillVersion } from './install.mjs';

const { values } = parseArgs({ options: { json: { type: 'boolean', default: false }, target: { type: 'string' } } });

const commands = [
  ['node', process.execPath, ['--version']],
  ['git', 'git', ['--version']],
  ['claude', 'claude', ['--version']],
  ['codex', 'codex', ['--version']],
  ['pi', 'pi', ['--version']],
  ['dsh', 'dsh', ['--version']],
];
const hosts = commands.map(([name, command, args]) => {
  const run = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true });
  const available = run.status === 0;
  return { name, available, version: available ? (run.stdout || '').trim().split('\n')[0].slice(0, 200) : null };
});

async function inspect(target) {
  const sourceVersion = await skillVersion(skillSource);
  const skills = [];
  for (const [harness, dir] of Object.entries(harnessDirs)) {
    const path = join(target, dir);
    const version = await skillVersion(path);
    skills.push({ harness, path: dir, installed: version !== null, version, current: version === sourceVersion });
  }
  const agents = [];
  for (const role of ['developer', 'fixer', 'reviewer', 'researcher']) {
    agents.push({ name: `rt-${role}`, installed: await exists(join(target, '.claude', 'agents', `rt-${role}.md`)) });
  }
  let installRecord = null;
  try { installRecord = JSON.parse(await readFile(join(target, '.roundtable', 'install.json'), 'utf8')); } catch {}
  return {
    target,
    sourceVersion,
    skills,
    claudeAgents: agents,
    config: {
      team: await exists(join(target, '.roundtable', 'team.md')),
      policy: await exists(join(target, '.roundtable', 'policy.md')),
    },
    installedVersion: installRecord?.skillVersion ?? null,
  };
}

const report = {
  schemaVersion: 2,
  hosts,
  backgroundWakeup: 'unverified',
  persistentDelegation: 'unverified',
  modelAuthentication: 'not-checked',
};
if (values.target) report.installation = await inspect(resolve(values.target));

if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log('Roundtable Work — read-only environment check');
  for (const host of hosts) console.log(`  ${host.name}: ${host.available ? host.version || 'available' : 'not available'}`);
  const inst = report.installation;
  if (inst) {
    console.log(`Installation in ${inst.target} (source skill ${inst.sourceVersion}):`);
    for (const s of inst.skills) console.log(`  ${s.harness} skill (${s.path}): ${s.installed ? `v${s.version}${s.current ? '' : ' — outdated, rerun install with --update'}` : 'not installed'}`);
    const agents = inst.claudeAgents.filter((a) => a.installed).map((a) => a.name);
    console.log(`  Claude Code subagents: ${agents.length ? agents.join(', ') : 'none'}`);
    console.log(`  .roundtable/team.md: ${inst.config.team ? 'present' : 'missing'} · policy.md: ${inst.config.policy ? 'present' : 'missing'}`);
  }
  console.log('Background wake-up and persistent delegation: not verified.');
  console.log('Model authentication: not checked. This does not install or start a team.');
}
