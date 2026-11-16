import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Checks for docs/deploy.md: required commands and targets, English only, no host-specific data,
// linked from the docs index, and the terminal-multiplexer note.

const root = fileURLToPath(new URL('..', import.meta.url));
const doc = readFileSync(join(root, 'docs', 'deploy.md'), 'utf8');
const index = readFileSync(join(root, 'docs', 'README.md'), 'utf8');
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

test('deploy doc exists and names the commands, flags, targets and compose file', () => {
  for (const term of ['rtd install', 'rtd uninstall', 'rtd doctor', '--dry-run', 'deploy/docker/compose.yaml', 'cloud server', 'macOS', 'Docker']) {
    assert.ok(doc.includes(term), term);
  }
});

test('deploy doc is English only', () => {
  assert.doesNotMatch(doc, CJK);
});

test('deploy doc has no IP addresses, home paths, user@host patterns or real host names', () => {
  assert.doesNotMatch(doc, /\b\d{1,3}(\.\d{1,3}){3}\b/);
  assert.doesNotMatch(doc, /\/home\//);
  assert.doesNotMatch(doc, /\/Users\//);
  assert.doesNotMatch(doc, /\/root\b/);
  assert.doesNotMatch(doc, /\S+@\S+/);
  assert.doesNotMatch(doc, /localhost/i);
});

test('docs index links to deploy.md', () => {
  assert.match(index, /\]\(deploy\.md\)/);
});

test('deploy doc says a terminal multiplexer is not a supervisor', () => {
  assert.match(doc, /multiplexer/i);
  assert.match(doc, /supervisor/i);
});
