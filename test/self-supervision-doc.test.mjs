import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Checks for docs/self-supervision.md: English only, no host identifiers, one Mermaid loop diagram, the required
// sections, a capability-map row for every capability, and runtime paths that exist unless named as planned work.

const root = fileURLToPath(new URL('..', import.meta.url));
const doc = readFileSync(join(root, 'docs', 'self-supervision.md'), 'utf8');
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

test('self-supervision doc is English only', () => {
  assert.doesNotMatch(doc, CJK);
});

test('self-supervision doc names no home paths or IP addresses', () => {
  assert.doesNotMatch(doc, /\/(?:home|Users|root)\/|~\//);
  assert.doesNotMatch(doc, /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/);
});

test('self-supervision doc has one Mermaid flowchart of the loop', () => {
  const blocks = [...doc.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /^flowchart /);
  for (const node of ['LEDGER', 'METRICS', 'GOALS', 'REVIEW', 'FILER', 'ASK', 'GOV', 'WD', 'STAGE']) {
    assert.match(blocks[0], new RegExp(`\\b${node}\\b`), node);
  }
});

test('self-supervision doc has the required sections', () => {
  for (const heading of [
    '## Capability map',
    '## (a) Intervention ledger and metrics',
    '## (b) External liveness that survives host freezes',
    '## (c) Goal file and self-sourced backlog',
    '## (d) Asks decided by default policy, never blocking',
    '## (e) Resource governor',
    '## (f) Host patch to tested rule',
    '## (g) Staged plan and exit criterion',
    '## Weak-model constraints',
    '## Risks and open questions',
    '## Work items',
  ]) assert.ok(doc.includes(`\n${heading}\n`), heading);
  assert.ok(doc.includes('**Final exit criterion.**'), 'final exit criterion');
});

test('capability map has one row per capability', () => {
  const section = doc.split('\n## Capability map\n')[1].split('\n## ')[0];
  for (const cap of ['L liveness', 'H self-repair', 'R resource', 'D decision', 'M merge', 'B backlog', 'S self-review', 'O owner']) {
    assert.match(section, new RegExp(`^\\| ${cap}`, 'm'), cap);
  }
});

test('the three real asks are fixtures of the default policy', () => {
  const section = doc.split('\n## (d) Asks decided by default policy, never blocking\n')[1].split('\n## ')[0];
  for (const n of [334, 340, 322]) assert.match(section, new RegExp(`^\\| #${n} \\|`, 'm'), `#${n}`);
});

test('runtime paths named in the doc exist unless they are planned work', () => {
  const paths = new Set([...doc.matchAll(/`((?:runtime|bin|scripts|deploy)\/[\w./-]+\.(?:mjs|json|service))`/g)].map((m) => m[1]));
  // Files that this document names as future work of the [RT-S] children, #337 and #391.
  const planned = new Set([
    'runtime/lib/interventions.mjs', 'scripts/rt-intervention.mjs', 'runtime/lib/self-metrics.mjs',
    'runtime/lib/governor.mjs', 'runtime/defaults/governor.json', 'runtime/lib/prune.mjs', 'runtime/goals.json',
    'runtime/lib/goals.mjs', 'runtime/lib/self-review.mjs', 'runtime/lib/self-review-filer.mjs',
    'runtime/lib/ask-policy.mjs', 'scripts/rt-host-patch.mjs', 'runtime/lib/stage.mjs', 'scripts/rt-stage.mjs',
    'runtime/defaults/observer.json',
  ]);
  for (const path of paths) {
    if (planned.has(path)) continue;
    assert.ok(existsSync(join(root, path)), path);
  }
});
