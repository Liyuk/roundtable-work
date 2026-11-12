import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function sources() {
  const files = [...await walk(join(repo, 'runtime')), ...await walk(join(repo, 'test', 'runtime'))];
  const doc = join(repo, 'docs', 'runtime-modules.md');
  files.push(doc);
  const result = [];
  for (const f of files) {
    try { result.push({ file: f.slice(repo.length), text: await readFile(f, 'utf8') }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return result;
}

// This file names the forbidden patterns, so it is excluded from its own scan.
const scanned = async () => (await sources()).filter((s) => !s.file.endsWith('hygiene.test.mjs'));
const runtimeOnly = async () => (await scanned()).filter((s) => s.file.startsWith('runtime/'));

test('runtime code never shells out or touches the network', async () => {
  const files = await runtimeOnly();
  assert.ok(files.length >= 5);
  for (const { file, text } of files) {
    if (file === 'runtime/lib/worktree.mjs') {
      // Git worktree lifecycle is the sole subprocess integration; keep it argument-based and local.
      assert.match(text, /node:child_process/);
      assert.match(text, /execFile/);
      assert.doesNotMatch(text, /\bexec\(/);
    } else assert.doesNotMatch(text, /child_process/, file);
    assert.doesNotMatch(text, /\bgh\s+(issue|pr|api|repo|release|label)\b/, file);
    assert.doesNotMatch(text, /node:(https?|net|dgram|tls)\b|\bfetch\(/, file);
  }
});

test('runtime code has no model-name references in code, tests or docs', async () => {
  for (const { file, text } of await scanned()) assert.doesNotMatch(text, new RegExp(['hai', 'ku'].join(''), 'i'), file);
});

test('runtime code has no absolute home directories', async () => {
  for (const { file, text } of await scanned()) assert.doesNotMatch(text, /\/home\/[a-z_][\w-]*|\/Users\/\w+/i, file);
});

test('runtime reuses lib/verdict.mjs instead of forking a verdict parser', async () => {
  const classify = (await runtimeOnly()).find((s) => s.file.endsWith('classify.mjs'));
  assert.match(classify.text, /from '\.\.\/\.\.\/lib\/verdict\.mjs'/);
  for (const { file, text } of await runtimeOnly()) assert.doesNotMatch(text, /===\s*'通过'|===\s*'打回'/, file);
});
