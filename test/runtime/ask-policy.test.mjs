import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAsk, inferScopeKind, SCOPE_KINDS } from '../../runtime/lib/ask-policy.mjs';

const base = { question: 'Which name?', options: ['A', 'B'], recommendation: 'A', evidence: ['docs/x.md'] };
const card = (over = {}) => ({ ...base, ...over });

test('1. rule table: first matching rule wins, in order', () => {
  const rows = [
    ['owner question: credentials', card({ category: 'credentials', scopeKind: 'acceptance-needs-files' }), { outcome: 'block', reason: 'owner-question' }],
    ['owner question: destructive', card({ category: 'destructive', recommendation: 'A' }), { outcome: 'block', reason: 'owner-question' }],
    ['owner question: production', card({ category: 'production' }), { outcome: 'block', reason: 'owner-question' }],
    ['rule 2: expand touch set', card({ scopeKind: 'acceptance-needs-files', evidence: ['a.mjs', 'b.mjs'] }), { outcome: 'resolve', resolution: 'expand-touch-set', paths: ['a.mjs', 'b.mjs'], rule: 'acceptance-needs-files' }],
    ['rule 2: more than 5 paths decomposes', card({ scopeKind: 'acceptance-needs-files', evidence: ['1', '2', '3', '4', '5', '6'] }), { outcome: 'resolve', resolution: 'decompose', paths: ['1', '2', '3', '4', '5', '6'], rule: 'acceptance-needs-files' }],
    ['rule 3: isolated reading', card({ scopeKind: 'criterion-unreliable' }), { outcome: 'resolve', resolution: 'isolated-reading', choice: 'A', rule: 'criterion-unreliable' }],
    ['rule 4: recommendation', card({ scopeKind: 'none', category: 'naming' }), { outcome: 'resolve', resolution: 'recommendation', choice: 'A', rule: 'recommendation' }],
    ['rule 5: no default', card({ scopeKind: 'scope-change', recommendation: undefined }), { outcome: 'block', reason: 'no-default' }],
  ];
  for (const [name, input, expected] of rows) {
    assert.deepEqual(resolveAsk({ card: input, issue: 1 }), expected, name);
  }
});

test('2. inferScopeKind: keyword rules, used when scopeKind is missing or not in the closed list', () => {
  assert.deepEqual(SCOPE_KINDS, ['acceptance-needs-files', 'criterion-unreliable', 'scope-change', 'none']);
  assert.equal(inferScopeKind('The touch set must grow to meet the acceptance.'), 'acceptance-needs-files');
  assert.equal(inferScopeKind('Touch set vs criterion: which wins?'), 'acceptance-needs-files');
  assert.equal(inferScopeKind('The count is wrong on a shared host.'), 'criterion-unreliable');
  assert.equal(inferScopeKind('Other processes change the global count.'), 'criterion-unreliable');
  assert.equal(inferScopeKind('The test is unreliable.'), 'criterion-unreliable');
  assert.equal(inferScopeKind('Which name should we use?'), 'none');
  assert.equal(inferScopeKind('The touch set is too small.'), 'none');

  const fallback = card({ question: 'Other worktrees change it.', scopeKind: 'bogus', recommendation: 'B' });
  assert.deepEqual(resolveAsk({ card: fallback, issue: 1 }), { outcome: 'resolve', resolution: 'isolated-reading', choice: 'B', rule: 'criterion-unreliable' });
  const missing = card({ question: 'Touch set plus acceptance?', evidence: ['x.mjs'] });
  assert.deepEqual(resolveAsk({ card: missing, issue: 1 }), { outcome: 'resolve', resolution: 'expand-touch-set', paths: ['x.mjs'], rule: 'acceptance-needs-files' });
  const explicit = card({ question: 'Other worktrees change it.', scopeKind: 'none', recommendation: 'B' });
  assert.deepEqual(resolveAsk({ card: explicit, issue: 1 }), { outcome: 'resolve', resolution: 'recommendation', choice: 'B', rule: 'recommendation' });
});

test('3. fixture #334: full tag list only in unreadable host files -> rule 4, choice A', () => {
  const c = card({
    question: 'The inventory needs every tag class; the full list exists only in host files the session cannot read.',
    options: ['A: post the list as a comment', 'B: authorise a read-only host pass'],
    recommendation: 'A: post the list as a comment',
  });
  assert.deepEqual(resolveAsk({ card: c, issue: 334 }), { outcome: 'resolve', resolution: 'recommendation', choice: 'A: post the list as a comment', rule: 'recommendation' });
});

test('4. fixture #340: merge check needs files outside the touch set -> expand touch set, not a listed option', () => {
  const c = card({
    question: 'The merge check refuses every merge; the writer needs files outside the touch set. Acceptance requires the loop to write the block.',
    options: ['a', 'b', 'c'],
    recommendation: 'a',
    scopeKind: 'acceptance-needs-files',
    evidence: ['runtime/lib/merge-writer.mjs', 'runtime/lib/merge-check.mjs'],
  });
  const r = resolveAsk({ card: c, issue: 340 });
  assert.deepEqual(r, { outcome: 'resolve', resolution: 'expand-touch-set', paths: ['runtime/lib/merge-writer.mjs', 'runtime/lib/merge-check.mjs'], rule: 'acceptance-needs-files' });
  assert.equal('choice' in r, false);
});

test('5. fixture #322: leak check counts global temp entries on a shared host -> isolated reading, choice A', () => {
  const c = card({
    question: 'check:leaks counts global temp entries that other worktrees change on a shared host.',
    options: ['A: private temp dir, global count informational', 'B: keep global count'],
    recommendation: 'A: private temp dir, global count informational',
  });
  assert.deepEqual(resolveAsk({ card: c, issue: 322 }), {
    outcome: 'resolve', resolution: 'isolated-reading', choice: 'A: private temp dir, global count informational', rule: 'criterion-unreliable',
  });
});

test('6. chief prompt carries the four required phrases', async () => {
  const text = await readFile(join(import.meta.dirname, '../../.agents/skills/roundtable-work/prompts/roles/chief.md'), 'utf8');
  for (const phrase of [
    'how to meet the issue\'s own acceptance is not an owner question',
    'expand the touch set to what the criterion needs',
    'safety files still follow the safety-merge rule',
    'replace an unreliable literal criterion with its reliable equivalent',
    'note it in the PR body',
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }
});
