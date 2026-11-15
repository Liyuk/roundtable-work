import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = readFileSync(new URL('../.agents/skills/roundtable-work/references/harnesses.md', import.meta.url), 'utf8');

test('harness doc names every harness', () => {
  for (const name of ['pi', 'codex', 'host-agent']) assert.match(doc, new RegExp(name));
});

test('harness doc states the degraded and read-only rules', () => {
  for (const keyword of ['degraded', 'not independent', 'read-only']) assert.ok(doc.includes(keyword), keyword);
});

test('harness doc lists the declared capability values', () => {
  for (const value of ['bash-wrapped', 'exec', 'in-process', 'subSession', 'writeFiles']) assert.ok(doc.includes(value), value);
});

test('harness doc is English only; the verdict tokens are the only allowed CJK', () => {
  const verdictTokens = ['审查结论：通过', '审查结论：打回', '审查结论：阻塞'];
  let rest = doc;
  for (const token of verdictTokens) rest = rest.split(token).join('');
  assert.doesNotMatch(rest, /[\u3400-\u9fff\uF900-\uFAFF]/);
});
