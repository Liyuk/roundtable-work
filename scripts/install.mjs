import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
export const skillSource = join(root, '.agents', 'skills', 'roundtable-work');
export const harnessDirs = {
  claude: join('.claude', 'skills', 'roundtable-work'),
  codex: join('.agents', 'skills', 'roundtable-work'),
};
const usage = `Usage: node scripts/install.mjs --target <workspace> [--harness claude,codex] [--dry-run] [--update] [--json]

Installs the Roundtable Work skill into a workspace for the chosen harnesses and
creates .roundtable/team.md and policy.md from templates when they are missing.
  --harness   claude -> .claude/skills + .claude/agents/rt-*.md; codex -> .agents/skills (default: both)
  --dry-run   print the plan without writing
  --update    refresh skill files and rt-* subagents that differ from this version
User-owned files in .roundtable/ are never overwritten.`;

export async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

export async function skillVersion(dir) {
  try {
    const text = await readFile(join(dir, 'SKILL.md'), 'utf8');
    return text.match(/^\s*version:\s*"?([\w.-]+)"?\s*$/m)?.[1] ?? null;
  } catch { return null; }
}

async function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(dir, rel));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

async function sameContent(a, b) {
  try { return (await readFile(a)).equals(await readFile(b)); } catch { return false; }
}

async function planFile(from, to, { update, owned }) {
  if (!await exists(to)) return { op: 'create', from, to };
  if (await sameContent(from, to)) return { op: 'unchanged', to };
  if (update && owned) return { op: 'update', from, to };
  return { op: 'skip', to, reason: owned ? 'differs; rerun with --update to refresh' : 'user-owned; not overwritten' };
}

export async function plan({ target, harnesses, update }) {
  const actions = [];
  const version = await skillVersion(skillSource);
  const sourceReal = await realpath(skillSource);
  for (const harness of harnesses) {
    const dest = join(target, harnessDirs[harness]);
    if (await exists(dest) && await realpath(dest) === sourceReal) {
      actions.push({ op: 'skip', to: dest, reason: 'this is the source skill' });
    } else {
      const installed = await skillVersion(dest);
      if (installed && installed !== version && !update) {
        actions.push({ op: 'skip', to: dest, reason: `installed version ${installed}; rerun with --update for ${version}` });
      } else {
        for (const file of await listFiles(skillSource)) {
          actions.push(await planFile(join(skillSource, file), join(dest, file), { update, owned: true }));
        }
      }
    }
    if (harness === 'claude') {
      const agentDir = join(skillSource, 'agents', 'claude');
      for (const file of await listFiles(agentDir)) {
        actions.push(await planFile(join(agentDir, file), join(target, '.claude', 'agents', file), { update, owned: true }));
      }
    }
  }
  const templates = join(skillSource, 'templates');
  for (const file of ['team.md', 'policy.md']) {
    actions.push(await planFile(join(templates, file), join(target, '.roundtable', file), { update: false, owned: false }));
  }
  for (const dir of ['tickets', 'state', 'memory']) {
    const to = join(target, '.roundtable', dir);
    actions.push(await exists(to) ? { op: 'unchanged', to } : { op: 'mkdir', to });
  }
  const recordPath = join(target, '.roundtable', 'install.json');
  let previous = [];
  try { previous = JSON.parse(await readFile(recordPath, 'utf8')).harnesses ?? []; } catch {}
  const allHarnesses = [...new Set([...previous, ...harnesses])].filter((h) => harnessDirs[h]);
  const record = { schemaVersion: 1, skillVersion: version, harnesses: allHarnesses, source: root, installedAt: new Date().toISOString() };
  actions.push({ op: 'write', to: recordPath, content: `${JSON.stringify(record, null, 2)}\n` });
  return { version, actions };
}

export async function apply(actions) {
  for (const action of actions) {
    if (action.op === 'create' || action.op === 'update') {
      await mkdir(dirname(action.to), { recursive: true });
      await copyFile(action.from, action.to);
    } else if (action.op === 'mkdir') {
      await mkdir(action.to, { recursive: true });
    } else if (action.op === 'write') {
      await mkdir(dirname(action.to), { recursive: true });
      await writeFile(action.to, action.content);
    }
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: 'string' },
      harness: { type: 'string', default: 'claude,codex' },
      'dry-run': { type: 'boolean', default: false },
      update: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.target) {
    console.log(usage);
    if (!values.help) process.exitCode = 2;
    return;
  }
  const target = resolve(values.target);
  if (!await exists(target) || !(await stat(target)).isDirectory()) throw new Error(`target is not a directory: ${target}`);
  const harnesses = [...new Set(values.harness.split(',').map((h) => h.trim()).filter(Boolean))];
  const unknown = harnesses.filter((h) => !harnessDirs[h]);
  if (unknown.length || !harnesses.length) throw new Error(`unknown harness: ${unknown.join(', ') || '(none)'}; use claude and/or codex`);

  const { version, actions } = await plan({ target, harnesses, update: values.update });
  const dryRun = values['dry-run'];
  if (!dryRun) await apply(actions);
  const summary = actions.reduce((acc, a) => ({ ...acc, [a.op]: (acc[a.op] ?? 0) + 1 }), {});
  if (values.json) {
    console.log(JSON.stringify({ schemaVersion: 1, target, version, harnesses, dryRun, summary, actions: actions.map(({ content, from, ...a }) => a) }, null, 2));
    return;
  }
  console.log(`Roundtable Work ${version} → ${target}${dryRun ? ' (dry run, nothing written)' : ''}`);
  // Collapse per-file skill actions into one line per skill directory and operation.
  const lines = new Map();
  for (const a of actions) {
    if (a.op === 'unchanged') continue;
    let path = a.to.slice(target.length + 1);
    const skillDir = Object.values(harnessDirs).find((dir) => path.startsWith(dir + sep));
    if (skillDir && !a.reason) path = `${skillDir}${sep}`;
    const key = `${a.op} ${path} ${a.reason ?? ''}`;
    const line = lines.get(key) ?? { op: a.op, path, reason: a.reason, count: 0 };
    line.count++;
    lines.set(key, line);
  }
  for (const { op, path, reason, count } of lines.values()) {
    const detail = [count > 1 ? `${count} files` : '', reason ?? ''].filter(Boolean).join('; ');
    console.log(`  ${op.padEnd(9)} ${path}${detail ? `  (${detail})` : ''}`);
  }
  console.log(`Summary: ${Object.entries(summary).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (!dryRun) {
    console.log('Next: edit .roundtable/policy.md, then run `node scripts/doctor.mjs --target <workspace>`.');
    console.log('This installs instructions and config only; it does not start agents or verify background wake-up.');
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error) => { console.error(`install: ${error.message}`); process.exitCode = 1; });
}
