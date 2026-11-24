// rt-agent role-memory preload (#605): a fake pi on PATH records the prompt it received. No network, no real harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS } from '../../runtime/lib/role-memory.mjs';
import { openMemoryStore } from '../../runtime/lib/memory-store.mjs';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROMPT = 'Base role prompt.';

// Fake pi: the prompt is the last argument; it is written to $FAKE_PI_PROMPT.
const FAKE_PI = `#!/usr/bin/env bash
printf '%s' "\${@: -1}" > "$FAKE_PI_PROMPT"
`;

function sandbox(t, flag) {
  const root = mkdtempSync(join(tmpdir(), 'rt-rolemem-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rtHome = join(root, 'home');
  const fakeBin = join(root, 'fakebin');
  mkdirSync(rtHome);
  mkdirSync(fakeBin);
  symlinkSync(join(hostDir, 'bin'), join(rtHome, 'bin'));
  const storeDir = join(root, 'store');
  writeFileSync(join(rtHome, 'config.env'), [
    'RT_HARNESS=pi', 'RT_FORCE_HARNESS=pi', 'RT_PI_MODEL_DEVELOPER=x/y', 'RT_MODEL=x/y',
    `RT_ROLE_MEMORY=${flag}`, `RT_ROLE_MEMORY_DIR=${storeDir}`, '',
  ].join('\n'));
  writeFileSync(join(fakeBin, 'pi'), FAKE_PI);
  chmodSync(join(fakeBin, 'pi'), 0o755);
  return { root, rtHome, fakeBin, storeDir, promptFile: join(root, 'prompt.txt') };
}

function launch(sb, prompt = PROMPT) {
  const wd = join(sb.root, 'wd');
  mkdirSync(wd, { recursive: true });
  const r = spawnSync(join(sb.rtHome, 'bin', 'rt-agent'), ['developer', wd, join(sb.root, 'out.txt')], {
    input: prompt,
    env: { ...process.env, RT_HOME: sb.rtHome, PATH: `${sb.fakeBin}:${process.env.PATH}`, FAKE_PI_PROMPT: sb.promptFile },
    encoding: 'utf8',
  });
  return { status: r.status, prompt: existsSync(sb.promptFile) ? readFileSync(sb.promptFile, 'utf8') : null };
}

test('flag off: the prompt is unchanged even when the store holds a lesson', (t) => {
  const sb = sandbox(t, 0);
  openMemoryStore({ dir: sb.storeDir }).save({ layer: 3, role: 'developer', id: 'rule:1', lesson: 'Run the tests first.', status: 'active' });
  const r = launch(sb);
  assert.equal(r.status, 0);
  assert.equal(r.prompt, PROMPT);
});

test('flag on with an empty store: the prompt is unchanged and the launch succeeds', (t) => {
  const sb = sandbox(t, 1);
  const r = launch(sb);
  assert.equal(r.status, 0);
  assert.equal(r.prompt, PROMPT);
});

test('flag on with a stored lesson: the memory section is appended', (t) => {
  const sb = sandbox(t, 1);
  openMemoryStore({ dir: sb.storeDir }).save({ layer: 3, role: 'developer', id: 'rule:1', lesson: 'Run the tests first.', status: 'active' });
  const r = launch(sb);
  assert.equal(r.status, 0);
  assert.equal(r.prompt, `${PROMPT}\n\n## Memory\nL3 rule:1: Run the tests first.`);
});

test('flag on: a long index is capped at LIMITS.preloadChars', (t) => {
  const sb = sandbox(t, 1);
  const store = openMemoryStore({ dir: sb.storeDir });
  for (let i = 0; i < 60; i++) store.save({ layer: 2, role: 'developer', id: `e:${i}`, cue: `cue ${i} ${'x'.repeat(80)}`, lesson: 'l' });
  const r = launch(sb);
  assert.equal(r.status, 0);
  const memory = r.prompt.slice(r.prompt.indexOf('## Memory\n') + '## Memory\n'.length);
  assert.ok(memory.length > 0 && memory.length <= LIMITS.preloadChars, `memory length ${memory.length}`);
  assert.ok(memory.startsWith('L2 e:0: cue 0 '));
  assert.ok(!memory.includes('L2 e:59:'));
});
