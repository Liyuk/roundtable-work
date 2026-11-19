import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exists, harnessDirs, skillSource, skillVersion } from './install.mjs';
import { classifyProbeResult } from './probe.mjs';
import { askConsent, checkSkills, loadManifest, MANIFEST } from './skill-deps.mjs';
import { CANDIDATES_FILE, HARNESS_CONFIG, HARNESSES, loadHarnessConfig, validateCandidates } from '../runtime/lib/harness.mjs';
import { loadRouting } from '../runtime/lib/routing.mjs';

const { values } = parseArgs({ options: { json: { type: 'boolean', default: false }, target: { type: 'string' }, routing: { type: 'string' } } });

const commands = [
  ['node', process.execPath, ['--version']],
  ['git', 'git', ['--version']],
  ['claude', 'claude', ['--version']],
  ['codex', 'codex', ['--version']],
  ['pi', 'pi', ['--version']],
  ['dsh', 'dsh', ['--version']],
];
const TIMEOUT_MS = 5000;
const reasons = new Map();
function probe(command, args) {
  const run = spawnSync(command, args, { encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 65536, windowsHide: true });
  return { ...classifyProbeResult(run, TIMEOUT_MS), run };
}
const hosts = commands.map(([name, command, args]) => {
  const probeResult = probe(command, args);
  const { status, run, reason } = probeResult;
  reasons.set(name, reason);
  const available = probeResult.available;
  return { name, available, version: available ? (run.stdout || '').trim().split('\n')[0].slice(0, 200) : null, status };
});

// Adapters reuse the host probe of the same-named binary; host-agent runs in-process and has no binary to probe.
const adapters = Object.values(HARNESSES).map(({ name, capabilities }) => {
  const host = hosts.find((h) => h.name === name);
  return host
    ? { name, available: host.available, capabilities }
    : { name, available: false, capabilities, status: 'no-binary', reason: 'runs in-process; no binary to probe' };
});

// Candidates are validated against the routing table and deny list, so an invalid file fails here rather than at wake time.
async function candidatesOf(target, routing) {
  const file = join(target, CANDIDATES_FILE);
  if (!routing || !await exists(file)) return null;
  const config = await loadHarnessConfig(HARNESS_CONFIG);
  const table = validateCandidates(JSON.parse(await readFile(file, 'utf8')), { routing, deny: config.deny });
  return Object.fromEntries(Object.entries(table.roles).map(([role, list]) => [role, list.map((e) => `${e.harness}/${e.model}`)]));
}

async function inspect(target, routing) {
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
    candidates: await candidatesOf(target, routing),
  };
}

const report = {
  schemaVersion: 2,
  hosts,
  adapters,
  backgroundWakeup: 'unverified',
  persistentDelegation: 'unverified',
  modelAuthentication: 'not-checked',
};
if (values.target) {
  report.installation = await inspect(resolve(values.target), values.routing ? await loadRouting(resolve(values.routing)) : null);
  report.skillDependencies = await checkSkills({ manifest: await loadManifest(MANIFEST), target: resolve(values.target), consent: askConsent });
}

if (values.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log('Roundtable Work — read-only environment check');
  for (const host of hosts) {
    const detail = host.status === 'not-found' ? 'not available' : `${host.status} (${reasons.get(host.name)})`;
    console.log(`  ${host.name}: ${host.available ? host.version || 'available' : detail}`);
  }
  for (const a of adapters) console.log(`  adapter ${a.name}: ${a.available ? 'available' : 'not available'}`);
  const inst = report.installation;
  if (inst) {
    console.log(`Installation in ${inst.target} (source skill ${inst.sourceVersion}):`);
    for (const s of inst.skills) console.log(`  ${s.harness} skill (${s.path}): ${s.installed ? `v${s.version}${s.current ? '' : ' — outdated, rerun install with --update'}` : 'not installed'}`);
    const agents = inst.claudeAgents.filter((a) => a.installed).map((a) => a.name);
    console.log(`  Claude Code subagents: ${agents.length ? agents.join(', ') : 'none'}`);
    console.log(`  .roundtable/team.md: ${inst.config.team ? 'present' : 'missing'} · policy.md: ${inst.config.policy ? 'present' : 'missing'}`);
    if (inst.candidates) for (const [role, list] of Object.entries(inst.candidates)) console.log(`  candidates ${role}: ${list.join(' → ')}`);
  }
  const deps = report.skillDependencies;
  if (deps) {
    for (const s of deps.skills) console.log(`  skill ${s.id} (${s.requirement}): ${s.status}${s.reason ? ` — ${s.reason}` : ''}${s.install ? ` · install: ${s.install}` : ''}`);
    console.log(deps.fallbackUsed ? 'Required skills missing or unverified: fallback will be used; the loop keeps running.' : 'Required skills verified at pin.');
  }
  console.log('Background wake-up and persistent delegation: not verified.');
  console.log('Model authentication: not checked. This does not install or start a team.');
}
