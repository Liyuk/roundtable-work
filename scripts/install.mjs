import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
export const skillSource = join(root, '.agents', 'skills', 'roundtable-work');
export const harnessDirs = {
  claude: join('.claude', 'skills', 'roundtable-work'),
  codex: join('.agents', 'skills', 'roundtable-work'),
};
const usage = `用法：node scripts/install.mjs --target <工作区> [--harness claude,codex] [--dry-run] [--update] [--json]

将 Roundtable Work 技能安装到指定工作区和运行环境；缺少时会根据模板创建 .roundtable/team.md 和 policy.md。
  --harness   claude -> .claude/skills + .claude/agents/rt-*.md；codex -> .agents/skills（默认：两者）
  --dry-run   仅显示计划，不写入文件
  --update    更新与此版本不同的技能文件和 rt-* 子代理
.roundtable/ 中由用户管理的文件不会被覆盖。`;

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
  if (!await exists(target) || !(await stat(target)).isDirectory()) throw new Error(`目标不是目录：${target}`);
  const harnesses = [...new Set(values.harness.split(',').map((h) => h.trim()).filter(Boolean))];
  const unknown = harnesses.filter((h) => !harnessDirs[h]);
  if (unknown.length || !harnesses.length) throw new Error(`未知运行环境：${unknown.join(', ') || '（无）'}；请使用 claude 和/或 codex`);

  const { version, actions } = await plan({ target, harnesses, update: values.update });
  const dryRun = values['dry-run'];
  if (!dryRun) await apply(actions);
  const summary = actions.reduce((acc, a) => ({ ...acc, [a.op]: (acc[a.op] ?? 0) + 1 }), {});
  if (values.json) {
    console.log(JSON.stringify({ schemaVersion: 1, target, version, harnesses, dryRun, summary, actions: actions.map(({ content, from, ...a }) => a) }, null, 2));
    return;
  }
  console.log(`Roundtable Work ${version} → ${target}${dryRun ? '（试运行，未写入任何内容）' : ''}`);
  // 将每个技能目录中的逐文件操作合并为一行。
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
    const detail = [count > 1 ? `${count} 个文件` : '', translateReason(reason)].filter(Boolean).join('；');
    console.log(`  ${translateOperation(op).padEnd(9)} ${path}${detail ? `  (${detail})` : ''}`);
  }
  console.log(`汇总：${Object.entries(summary).map(([k, v]) => `${translateOperation(k)} ${v}`).join('，')}`);
  if (!dryRun) {
    console.log('下一步：编辑 .roundtable/policy.md，然后运行 `node scripts/doctor.mjs --target <工作区>`。');
    console.log('本命令仅安装说明和配置；不会启动代理，也不会验证后台唤醒。');
  }
}

function translateOperation(op) {
  return ({ create: '新建', update: '更新', skip: '跳过', mkdir: '创建目录', write: '写入', unchanged: '未变更' })[op] ?? op;
}

function translateReason(reason) {
  if (!reason) return '';
  return reason
    .replace('differs; rerun with --update to refresh', '内容不同；请使用 --update 重新安装')
    .replace('user-owned; not overwritten', '由用户管理；未覆盖')
    .replace('this is the source skill', '这是源技能目录')
    .replace(/^installed version (.+); rerun with --update for (.+)$/, '已安装版本 $1；请使用 --update 更新到 $2');
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main().catch((error) => { console.error(`安装失败：${error.message}`); process.exitCode = 1; });
}
