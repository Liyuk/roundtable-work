import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const compose = join(root, 'deploy/docker/compose.yaml');
const healthcheck = join(root, 'deploy/docker/healthcheck.mjs');
const hasDocker = spawnSync('docker', ['--version']).status === 0;
const SECRET_LIKE = /(token|secret|password|passwd|api[_-]?key)\w*\s*[:=]\s*\S/i;

test('compose file defines the rtd service with restart policy, healthcheck and no secrets', async () => {
  const text = await readFile(compose, 'utf8');
  assert.match(text, /^services:\n  rtd:\n/m);
  assert.match(text, /^    restart: unless-stopped$/m);
  assert.match(text, /^    healthcheck:$/m);
  assert.doesNotMatch(text, SECRET_LIKE);
});

test('healthcheck fails for missing, malformed or stale heartbeat and passes when fresh', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rtd-health-'));
  try {
    const run = () => spawnSync(process.execPath, [healthcheck], { cwd: dir }).status;
    assert.notEqual(run(), 0, 'missing heartbeat');
    const file = join(dir, '.roundtable/state/heartbeat.json');
    await mkdir(join(dir, '.roundtable/state'), { recursive: true });
    await writeFile(file, '{not json');
    assert.notEqual(run(), 0, 'malformed heartbeat');
    await writeFile(file, JSON.stringify({ writtenAt: Date.now() - 130000 }));
    assert.notEqual(run(), 0, 'stale heartbeat');
    await writeFile(file, JSON.stringify({ writtenAt: Date.now() }));
    assert.equal(run(), 0, 'fresh heartbeat');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('docker compose config succeeds without an env file', { skip: !hasDocker }, () => {
  const result = spawnSync('docker', ['compose', '-f', compose, 'config'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
