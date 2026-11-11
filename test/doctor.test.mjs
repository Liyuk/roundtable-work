import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyProbeResult } from '../scripts/probe.mjs';

const cli = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const run = (script, args) => JSON.parse(execFileSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' }));

test('classifyProbeResult 区分运行环境状态，并在成功时保留成功状态', () => {
  assert.deepEqual(classifyProbeResult({ status: 0, stdout: 'v1\n' }), { status: 'ok', available: true, reason: null });
  assert.deepEqual(classifyProbeResult({ status: null, error: { code: 'ENOENT' } }), { status: 'not-found', available: false, reason: 'not found on PATH' });
  assert.deepEqual(classifyProbeResult({ status: 3 }), { status: 'failed', available: false, reason: 'exited with code 3' });
  assert.deepEqual(classifyProbeResult({ status: null, error: { code: 'ETIMEDOUT' } }), { status: 'timeout', available: false, reason: 'timed out after 5s' });
  assert.deepEqual(classifyProbeResult({ status: 0, stdout: 'v1\n', error: { code: 'EPERM' } }), { status: 'ok', available: true, reason: null });
});

test('doctor 报告检测到的可执行文件，不推断运行能力', () => {
  const result = run(cli, []);
  assert.equal(result.schemaVersion, 2);
  assert.ok(result.hosts.some((host) => host.name === 'node' && host.available));
  assert.ok(result.hosts.some((host) => host.name === 'claude'));
  assert.ok(result.hosts.every((host) => typeof host.available === 'boolean'));
  assert.equal(result.backgroundWakeup, 'unverified');
  assert.equal(result.persistentDelegation, 'unverified');
  assert.equal(result.modelAuthentication, 'not-checked');
  assert.equal(result.installation, undefined);
});

test('doctor --target 报告安装器在工作区中的安装结果', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'rtw-doctor-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  assert.ok(run(cli, ['--target', target]).installation.skills.every((s) => !s.installed));
  run(installer, ['--target', target]);
  const inst = run(cli, ['--target', target]).installation;
  assert.ok(inst.skills.every((s) => s.installed && s.current));
  assert.ok(inst.claudeAgents.every((a) => a.installed));
  assert.deepEqual(inst.config, { team: true, policy: true });
  assert.equal(inst.installedVersion, inst.sourceVersion);
});

test('doctor 区分运行环境的正常、未找到、失败和超时状态（PATH 中使用伪命令）', { skip: process.platform === 'win32' }, (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'rtw-fakebin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const fake = (name, body) => { const f = join(bin, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); };
  fake('claude', 'echo "claude fake 1.2.3"');
  fake('codex', 'exit 3');
  const sleepBin = execFileSync('/bin/sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim(); // 下方设置的 PATH 中不包含 sleep
  fake('pi', `exec ${sleepBin} 30`);
  // 故意不提供 dsh；PATH 仅包含伪命令目录，因此 git 也不可用。
  const env = { ...process.env, PATH: `${bin}:/nonexistent` };
  const opts = { encoding: 'utf8', env };
  const json = JSON.parse(execFileSync(process.execPath, [cli, '--json'], opts));
  const by = Object.fromEntries(json.hosts.map((h) => [h.name, h]));
  assert.deepEqual(by.claude, { name: 'claude', available: true, version: 'claude fake 1.2.3', status: 'ok' });
  assert.deepEqual(by.codex, { name: 'codex', available: false, version: null, status: 'failed' });
  assert.deepEqual(by.pi, { name: 'pi', available: false, version: null, status: 'timeout' });
  assert.deepEqual(by.dsh, { name: 'dsh', available: false, version: null, status: 'not-found' });
  assert.ok(json.hosts.every((h) => ['ok', 'not-found', 'failed', 'timeout'].includes(h.status)));
  const text = execFileSync(process.execPath, [cli], opts);
  assert.match(text, /codex: 失败（退出码：3）/);
  assert.match(text, /pi: 超时（运行超时（5 秒））/);
  assert.match(text, /dsh: 不可用/);
});
