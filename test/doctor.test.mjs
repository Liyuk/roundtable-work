import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
const installer = fileURLToPath(new URL('../scripts/install.mjs', import.meta.url));
const run = (script, args) => JSON.parse(execFileSync(process.execPath, [script, ...args, '--json'], { encoding: 'utf8' }));

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

test('doctor --target reports what the installer put in a workspace', () => {
  const target = mkdtempSync(join(tmpdir(), 'rtw-doctor-'));
  assert.ok(run(cli, ['--target', target]).installation.skills.every((s) => !s.installed));
  run(installer, ['--target', target]);
  const inst = run(cli, ['--target', target]).installation;
  assert.ok(inst.skills.every((s) => s.installed && s.current));
  assert.ok(inst.claudeAgents.every((a) => a.installed));
  assert.deepEqual(inst.config, { team: true, policy: true });
  assert.equal(inst.installedVersion, inst.sourceVersion);
});
