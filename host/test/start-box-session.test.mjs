// tmux session name in host/start-box.sh: RT_SESSION wins, else derived from the instance dir. No tmux server; fake tmux logs argv.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const START_BOX = join(hostDir, 'start-box.sh');

// Runs a copy of start-box.sh from <root>/<dirName>/ with a fake tmux (has-session fails, so new-session runs) and a stub rt-agent.
function startBox(t, dirName, extraEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rt-session-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const instance = join(root, dirName);
  mkdirSync(join(instance, 'bin'), { recursive: true });
  copyFileSync(START_BOX, join(instance, 'start-box.sh'));
  writeFileSync(join(instance, 'bin', 'rt-agent'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(instance, 'bin', 'rt-agent'), 0o755);
  const fakeBin = join(root, 'fakebin');
  mkdirSync(fakeBin);
  const log = join(root, 'tmux.log');
  writeFileSync(join(fakeBin, 'tmux'), `#!/bin/sh\necho "$*" >> "${log}"\n[ "$1" = has-session ] && exit 1\nexit 0\n`);
  chmodSync(join(fakeBin, 'tmux'), 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
  delete env.RT_SESSION;
  delete env.RT_HOME;
  Object.assign(env, extraEnv);
  const r = spawnSync(join(instance, 'start-box.sh'), { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  return {
    hasSession: lines.find((l) => l.startsWith('has-session')),
    newSession: lines.find((l) => l.startsWith('new-session')),
  };
}

test('RT_SESSION overrides the name in has-session and new-session', (t) => {
  const r = startBox(t, 'rt-loop', { RT_SESSION: 'custom-s' });
  assert.equal(r.hasSession, 'has-session -t custom-s');
  assert.ok(r.newSession.startsWith('new-session -d -s custom-s '), r.newSession);
});

test('default for an instance dir named rt-loop is rt-loop', (t) => {
  const r = startBox(t, 'rt-loop');
  assert.equal(r.hasSession, 'has-session -t rt-loop');
  assert.ok(r.newSession.startsWith('new-session -d -s rt-loop '), r.newSession);
});

test('default for another dir name is rt-loop-<sanitized basename>', (t) => {
  const r = startBox(t, 'box.dev-1');
  assert.equal(r.hasSession, 'has-session -t rt-loop-box_dev-1');
  assert.ok(r.newSession.startsWith('new-session -d -s rt-loop-box_dev-1 '), r.newSession);
});
