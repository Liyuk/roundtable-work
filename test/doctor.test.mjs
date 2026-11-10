import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
test('doctor reports observed executables without asserting runtime capability', () => {
  const result = JSON.parse(execFileSync(process.execPath, [cli, '--json'], { encoding: 'utf8' }));
  assert.equal(result.schemaVersion, 1);
  assert.ok(result.hosts.some((host) => host.name === 'node' && host.available));
  assert.ok(result.hosts.every((host) => typeof host.available === 'boolean'));
  assert.equal(result.backgroundWakeup, 'unverified');
  assert.equal(result.persistentDelegation, 'unverified');
  assert.equal(result.modelAuthentication, 'not-checked');
});
