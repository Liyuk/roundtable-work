import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { exists, harnessDirs, skillSource, skillVersion } from './install.mjs';
import { classifyProbeResult } from './probe.mjs';

const { values } = parseArgs({ options: { json: { type: 'boolean', default: false }, target: { type: 'string' } } });

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
  console.log('Roundtable Work — 只读环境检查');
  for (const host of hosts) {
    const statusLabels = { ok: '正常', 'not-found': '未找到', failed: '失败', timeout: '超时' };
    const reasonLabels = {
      'not found on PATH': 'PATH 中未找到',
      [`timed out after ${TIMEOUT_MS / 1000}s`]: `运行超时（${TIMEOUT_MS / 1000} 秒）`,
    };
    const reason = reasons.get(host.name);
    const localizedReason = reasonLabels[reason] ?? (reason ?? '')
      .replace(/^could not run: /, '无法运行：')
      .replace(/^killed by /, '被信号终止：')
      .replace(/^exited with code /, '退出码：');
    const detail = host.status === 'not-found' ? '不可用' : `${statusLabels[host.status]}（${localizedReason}）`;
    console.log(`  ${host.name}: ${host.available ? host.version || '可用' : detail}`);
  }
  const inst = report.installation;
  if (inst) {
    console.log(`安装位置：${inst.target}（源技能版本 ${inst.sourceVersion}）：`);
    for (const s of inst.skills) console.log(`  ${s.harness} 技能（${s.path}）：${s.installed ? `v${s.version}${s.current ? '' : ' — 版本过旧，请使用 --update 重新安装'}` : '未安装'}`);
    const agents = inst.claudeAgents.filter((a) => a.installed).map((a) => a.name);
    console.log(`  Claude Code 子代理：${agents.length ? agents.join(', ') : '无'}`);
    console.log(`  .roundtable/team.md：${inst.config.team ? '存在' : '缺失'} · policy.md：${inst.config.policy ? '存在' : '缺失'}`);
  }
  console.log('后台唤醒和持久委派：未验证。');
  console.log('模型身份验证：未检查。本检查不会安装或启动团队。');
}
