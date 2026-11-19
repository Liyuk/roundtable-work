import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'practice', 'skills', 'manifest.json'), 'utf8'));
const required = manifest.skills.filter((s) => s.requirement === 'required');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

test('every required manifest entry points to a non-empty, English-only fallback file', () => {
  assert.equal(required.length, 10);
  for (const s of required) {
    assert.ok(s.fallbackFile, `${s.id}: fallbackFile must be set`);
    const path = join(root, s.fallbackFile);
    assert.ok(existsSync(path), `${s.id}: ${s.fallbackFile} must exist`);
    assert.ok(statSync(path).size > 0, `${s.id}: ${s.fallbackFile} must be non-empty`);
    assert.doesNotMatch(read(s.fallbackFile), /\p{Script=Han}/u, `${s.id}: no Han characters`);
  }
});

test('show-me-your-work lists the six TSV columns in order and documents ts and evidence', () => {
  const text = read('practice/fallback/show-me-your-work.md');
  const columns = ['ts', 'phase', 'decision', 'why', 'evidence', 'result'];
  const at = columns.map((c) => text.indexOf(`\`${c}\``));
  assert.ok(at.every((i) => i >= 0) && at.every((i, k) => k === 0 || i > at[k - 1]), `columns out of order: ${at}`);
  assert.match(text, /UTC/);
  assert.match(text, /evidence[^\n]*pointer/i);
});

test('architect fallback limits its trigger to new-module or cross-module design', () => {
  assert.match(read('practice/fallback/architect.md'), /new-module or cross-module/);
});

test('review-and-finish.md exists as the shared rules file', () => {
  assert.ok(existsSync(join(root, 'practice', 'fallback', 'review-and-finish.md')));
});
