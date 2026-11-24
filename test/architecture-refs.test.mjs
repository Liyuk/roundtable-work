import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArchitectureRefs } from '../scripts/check-architecture-refs.mjs';

// The reference check reads the module-status catalog of docs/architecture.md: every code path must exist in the tree
// and every issue must exist. Issue lookups are injected here, so the tests never reach the network.

const root = fileURLToPath(new URL('..', import.meta.url));
const doc = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
const allIssuesExist = async () => true;

function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length, 2, `"${from}" must occur once in the catalog`);
  return text.replace(from, to);
}

test('a valid catalog has no problems', async () => {
  assert.deepEqual(await checkArchitectureRefs({ doc, root, issueExists: allIssuesExist }), []);
});

test('a code path that is not in the tree is reported with its module', async () => {
  const stale = replaceOnce(doc, '"code": ["runtime/lib/outbox.mjs", ', '"code": ["runtime/lib/no-such-module.mjs", ');
  const problems = await checkArchitectureRefs({ doc: stale, root, issueExists: allIssuesExist });
  assert.deepEqual(problems, ['outbox: missing file runtime/lib/no-such-module.mjs']);
});

test('an issue that does not exist is reported with its module', async () => {
  const problems = await checkArchitectureRefs({ doc, root, issueExists: async (n) => n !== 377 });
  assert.deepEqual(problems, ['daemon: issue #377 does not exist']);
});

test('an issue lookup is made once per distinct issue number', async () => {
  const asked = [];
  await checkArchitectureRefs({ doc, root, issueExists: async (n) => { asked.push(n); return true; } });
  assert.equal(asked.length, new Set(asked).size);
  assert.ok(asked.includes(377));
});

test('a catalog that cannot be parsed is an error, not a pass', async () => {
  await assert.rejects(checkArchitectureRefs({ doc: '# no catalog', root, issueExists: allIssuesExist }), /no rt:module-status block/);
});
