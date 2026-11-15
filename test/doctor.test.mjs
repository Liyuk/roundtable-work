import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyProbeResult } from '../scripts/probe.mjs';
import { HARNESSES } from '../runtime/lib/harness.mjs';

const cli = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const run = (script, args) => JSON.parse(execFileSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' }));

test('classifyProbeResult distinguishes host outcomes and preserves successful status with error', () => {
  assert.deepEqual(classifyProbeResult({ status: 0, stdout: 'v1\n' }), { status: 'ok', available: true, reason: null });
  assert.deepEqual(classifyProbeResult({ status: null, error: { code: 'ENOENT' } }), { status: 'not-found', available: false, reason: 'not found on PATH' });
  assert.deepEqual(classifyProbeResult({ status: 3 }), { status: 'failed', available: false, reason: 'exited with code 3' });
  assert.deepEqual(classifyProbeResult({ status: null, error: { code: 'ETIMEDOUT' } }), { status: 'timeout', available: false, reason: 'timed out after 5s' });
  assert.deepEqual(classifyProbeResult({ status: 0, error: { code: 'ETIMEDOUT' } }), { status: 'timeout', available: false, reason: 'timed out after 5s' });
  assert.deepEqual(classifyProbeResult({ status: 0, stdout: 'v1\n', error: { code: 'EPERM' } }), { status: 'ok', available: true, reason: null });
});

test('doctor reports observed executables without asserting runtime capability', () => {
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

test('doctor --target reports what the installer put in a workspace', (t) => {
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

test('doctor host status distinguishes ok / not-found / failed / timeout (fake commands on PATH)', { skip: process.platform === 'win32' }, (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'rtw-fakebin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const fake = (name, body) => { const f = join(bin, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); };
  fake('claude', 'echo "claude fake 1.2.3"');
  fake('codex', 'exit 3');
  const sleepBin = execFileSync('/bin/sh', ['-c', 'command -v sleep'], { encoding: 'utf8' }).trim(); // PATH below hides sleep
  fake('pi', `exec ${sleepBin} 30`);
  // dsh is intentionally absent; PATH contains only the fake dir, so git is absent too.
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
  assert.match(text, /codex: failed \(exited with code 3\)/);
  assert.match(text, /pi: timeout \(timed out after 5s\)/);
  assert.match(text, /dsh: not available/);
});

test('doctor adapters mirror HARNESSES, reusing the host probe (fake binaries on PATH)', { skip: process.platform === 'win32' }, (t) => {
  const bin = mkdtempSync(join(tmpdir(), 'rtw-adapters-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const fake = (name, body) => { const f = join(bin, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); };
  fake('pi', 'exit 0');
  fake('codex', 'exit 3');
  const opts = { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:/nonexistent` } };
  const json = JSON.parse(execFileSync(process.execPath, [cli, '--json'], opts));
  const by = Object.fromEntries(json.adapters.map((a) => [a.name, a]));
  assert.equal(json.schemaVersion, 2);
  assert.equal(json.adapters.length, Object.keys(HARNESSES).length);
  assert.equal(by.pi.available, true);
  assert.equal(by.codex.available, false);
  assert.equal(by['host-agent'].available, false);
  assert.equal(by['host-agent'].status, 'no-binary');
  for (const name of Object.keys(HARNESSES)) assert.deepEqual(by[name].capabilities, HARNESSES[name].capabilities);
  const text = execFileSync(process.execPath, [cli], opts);
  assert.match(text, /^ {2}adapter pi: available$/m);
  assert.match(text, /^ {2}adapter codex: not available$/m);
  assert.match(text, /^ {2}adapter host-agent: not available/m);
});
