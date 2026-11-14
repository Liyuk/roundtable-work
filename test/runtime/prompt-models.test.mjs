import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Family names are split so this file itself passes the hygiene scan for model names.
const FAMILIES = ['op' + 'us', 'son' + 'net', 'hai' + 'ku', 'deep' + 'seek', 'gp' + 't', 'co' + 'dex', 'clau' + 'de', 'gem' + 'ini'];
const MODEL_NAME = new RegExp(`\\b(${FAMILIES.join('|')})\\b`, 'gi');
const PROMPT_ROOTS = [
  fileURLToPath(new URL('../../.agents/skills/roundtable-work/prompts/', import.meta.url)),
  fileURLToPath(new URL('../../runtime/prompts/', import.meta.url)),
];

test('prompt templates name no model family; role routing comes only from the injected routing block', async () => {
  const files = [];
  for (const root of PROMPT_ROOTS) {
    for (const entry of await readdir(root, { recursive: true })) if (entry.endsWith('.md')) files.push(join(root, entry));
  }
  assert.ok(files.length > 0);
  const found = [];
  for (const file of files) {
    for (const match of (await readFile(file, 'utf8')).matchAll(MODEL_NAME)) found.push(`${file}: ${match[0]}`);
  }
  assert.deepEqual(found, []);
});
