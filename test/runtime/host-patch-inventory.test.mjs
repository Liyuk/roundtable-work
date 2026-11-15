import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const docPath = 'docs/host-patch-inventory.md';
const TAG_CLASSES = ['codex', 'escalate', 'limit', 'limitmain', 'budget', 'nofunds', 'routing', 'allpi', 'luna', 'w6', 'migrate',
  'author', 'ac', 'gate', 'lenient', 'review / reviewer', 'skills', 'followup', 'blockedrtm', 'series', 'utf8', 'waitguard',
  'tmpclean', 'cirerun', 'ciwait', 'mergelock', 'nopr-close', 'recordretry', 'safetyfmt', 'subretry', 'syncbudget', 'trim',
  'dated snapshots 20261112/20261113'];
const REASON = /^(?:not ported: |superseded by )\S/;
const REFERENCE = /^`([^`]+)` \+ `([^`]+)` :: (.+)$/;

/** Rows of the inventory table: the cells of every row after the header and separator lines. */
function parseRows(markdown) {
  const lines = markdown.split('\n').filter((line) => line.startsWith('|'));
  const header = lines.findIndex((line) => line.startsWith('| Tag class |'));
  return lines.slice(header + 2).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return { tag: cells[0], cellCount: cells.length, mapping: cells[2] ?? '' };
  });
}

/** Every problem in the table; an empty list means the inventory is complete and every reference resolves. */
async function problems(markdown) {
  const found = [];
  for (const { tag, cellCount, mapping } of parseRows(markdown)) {
    if (cellCount !== 3) { found.push(`${tag}: malformed row`); continue; }
    if (REASON.test(mapping)) continue;
    const reference = REFERENCE.exec(mapping);
    if (!reference) { found.push(`${tag}: no test reference or reason`); continue; }
    const [, runtimeFile, testFile, name] = reference;
    try { await access(join(root, runtimeFile)); } catch { found.push(`${tag}: missing file ${runtimeFile}`); }
    let testText = null;
    try { testText = await readFile(join(root, testFile), 'utf8'); } catch { found.push(`${tag}: missing file ${testFile}`); }
    if (testText !== null && !testText.includes(`test('${name}'`)) found.push(`${tag}: test name not found in ${testFile}`);
  }
  return found;
}

const table = (...rows) => ['| Tag class | Behavior | Mapping |', '|---|---|---|', ...rows].join('\n');

test('the committed inventory has a valid mapping for every row', async () => {
  assert.deepEqual(await problems(await readFile(join(root, docPath), 'utf8')), []);
});

test('the inventory has exactly one row per tag class, in the owner order', async () => {
  assert.deepEqual(parseRows(await readFile(join(root, docPath), 'utf8')).map((row) => row.tag), TAG_CLASSES);
});

test('a row with neither a test reference nor a reason is reported', async () => {
  assert.deepEqual(await problems(table('| codex | behavior | see the old notes |')), ['codex: no test reference or reason']);
});

test('a reference to a missing file or a missing test name is reported', async () => {
  const found = await problems(table(
    '| x | behavior | `runtime/lib/missing.mjs` + `test/runtime/state.test.mjs` :: fresh state has zeroed counters; updates persist across store instances |',
    '| y | behavior | `runtime/lib/state.mjs` + `test/runtime/state.test.mjs` :: no such test name |',
  ));
  assert.deepEqual(found, [
    'x: missing file runtime/lib/missing.mjs',
    'y: test name not found in test/runtime/state.test.mjs',
  ]);
});

test('a valid test reference and a not-ported or superseded reason both pass', async () => {
  assert.deepEqual(await problems(table(
    '| a | behavior | `runtime/lib/state.mjs` + `test/runtime/state.test.mjs` :: fresh state has zeroed counters; updates persist across store instances |',
    '| b | behavior | not ported: no runtime counterpart |',
    '| c | behavior | superseded by #288 rule 10 |',
  )), []);
});
