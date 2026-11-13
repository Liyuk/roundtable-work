import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const prompt = readFileSync(new URL('../.agents/skills/roundtable-work/prompts/roles/reviewer.md', import.meta.url), 'utf8');

test('reviewer prompt uses the required check order and concise rationale', () => {
  const order = [
    'acceptance criteria',
    'interfaces and formats specified by the issue',
    'claims verified against the code and tests',
    'internal consistency',
    'downstream fitness',
    'finish',
  ];
  const positions = order.map((phrase) => prompt.toLowerCase().indexOf(phrase));
  assert.ok(positions.every((position) => position >= 0), 'all review steps must be present');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'review steps must appear in order');
  assert.match(prompt, /artifact and acceptance[^\n]*first/i);
  assert.match(prompt, /developer.s self-report[^\n]*last/i);
  assert.match(prompt, /length and polish are not merits/i);
  assert.match(prompt, /at most 6 lines/i);
  assert.match(prompt, /decisive criterion/i);
  assert.match(prompt, /审查结论：通过 \| 打回 \| 阻塞[^\n]*first line/);
});
