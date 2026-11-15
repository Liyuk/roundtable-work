import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Checks for docs/architecture.md: English only, one Mermaid system diagram, the required sections,
// a valid module-status block whose code paths exist, and runtime paths that exist.

const root = fileURLToPath(new URL('..', import.meta.url));
const doc = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

test('architecture doc is English only', () => {
  assert.doesNotMatch(doc, CJK);
});

test('architecture doc has one Mermaid flowchart with the owner structure and status classes', () => {
  const blocks = [...doc.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1);
  const [chart] = blocks;
  assert.match(chart, /^flowchart /);
  for (const node of ['INTAKE', 'INBOX', 'PIPE', 'TIERS', 'APPROVAL', 'OUTBOX', 'IM', 'SCHED']) {
    assert.match(chart, new RegExp(`\\b${node}\\b`), node);
  }
  for (const cls of ['impl', 'partial', 'lib', 'missing']) assert.match(chart, new RegExp(`classDef ${cls} `), cls);
});

test('architecture doc has the required sections', () => {
  for (const heading of [
    '## The daemon cycle',
    '## Modules',
    '## Decision rules: tiers and approval modes',
    '## Execute by default, confirm, amend, roll back',
    '### Rollback contract',
    '### Owner reply flows',
    '## Weak-model constraints',
    '## Real failures and their mechanisms',
    '## Production cutover plan',
  ]) assert.ok(doc.includes(`\n${heading}\n`), heading);
  for (const tier of ['auto-silent', 'auto-notify', 'approve-first']) assert.ok(doc.includes(`\`${tier}\``), tier);
});

test('every real failure 1-14 has a row', () => {
  const section = doc.split('## Real failures and their mechanisms')[1].split('\n## ')[0];
  for (let n = 1; n <= 14; n++) assert.match(section, new RegExp(`^\\| ${n} \\|`, 'm'), `failure ${n}`);
});

test('module-status block is valid and its code paths exist', () => {
  const match = /<!-- rt:module-status -->\n```json\n([\s\S]*?)```/.exec(doc);
  assert.ok(match, 'module-status block');
  const modules = JSON.parse(match[1]);
  const ids = new Set();
  for (const m of modules) {
    assert.ok(typeof m.id === 'string' && !ids.has(m.id), `id ${m.id}`);
    ids.add(m.id);
    assert.ok(typeof m.name === 'string' && m.name.length > 0);
    assert.ok(['implemented', 'partial', 'library-only', 'missing'].includes(m.status), `${m.id} status`);
    assert.ok(Array.isArray(m.issues) && m.issues.every(Number.isInteger));
    for (const path of m.code) assert.ok(existsSync(join(root, path)), `${m.id}: ${path}`);
  }
});

test('runtime paths named in the doc exist', () => {
  const paths = new Set([...doc.matchAll(/`((?:runtime|bin|scripts|deploy)\/[\w./-]+\.(?:mjs|json|service))`/g)].map((m) => m[1]));
  // Files that this document names as future work.
  const planned = new Set(['runtime/defaults/autonomy.json', 'scripts/cutover-check.mjs']);
  for (const path of paths) {
    if (planned.has(path)) continue;
    assert.ok(existsSync(join(root, path)), path);
  }
});
