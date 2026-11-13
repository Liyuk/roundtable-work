import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const prompt = readFileSync(new URL('../.agents/skills/roundtable-work/prompts/roles/reviewer.md', import.meta.url), 'utf8');

const CARD_FIELDS = [
  'Ticket / assignment / attempt / target version',
  'Status',
  'Executor / Reviewer',
  'Conclusion and scope of completion (verify each acceptance criterion)',
  '产物 (Artifacts), changes or PR links / reviewed version or HEAD',
  'Actually run checks',
  'Checks not run and why',
  '未完成项 (Incomplete items), risks and unknown external side effects',
  '需要人或 Chief 决定 (Items that require a human or Chief decision)',
  'Recommended next steps',
];

const validVerdictCard = `审查结论：打回
- Ticket / assignment / attempt / target version: #176 / review / 1 / abc123
- Status: 部分完成
- Executor / Reviewer: developer / reviewer
- Conclusion and scope of completion (verify each acceptance criterion):
  - F1: The regression fixture did not reject reordered card fields.
  - The rationale names the decisive acceptance criterion.
- 产物 (Artifacts), changes or PR links / reviewed version or HEAD: test/reviewer-prompt.test.mjs / abc123
- Actually run checks: npm test — exit 1
- Checks not run and why: none
- 未完成项 (Incomplete items), risks and unknown external side effects: format test is missing
- 需要人或 Chief 决定 (Items that require a human or Chief decision): none
- Recommended next steps: fix the fixture and rerun checks`;

function hasValidVerdictCardFormat(card) {
  const lines = card.split(/\r?\n/);
  if (!/^审查结论：(通过|打回|阻塞)$/.test(lines[0])) return false;
  const fieldLines = lines.filter((line) => line.startsWith('- '));
  const headings = fieldLines.map((line) => line.slice(2, line.indexOf(':')));
  if (!fieldLines.every((line) => line.includes(':')) || !deepEqual(headings, CARD_FIELDS)) return false;
  const conclusionLine = lines.findIndex((line) => line.startsWith(`- ${CARD_FIELDS[3]}:`));
  const nextField = lines.findIndex((line, index) => index > conclusionLine && line.startsWith('- '));
  const rationale = lines.slice(conclusionLine + 1, nextField).filter((line) => line.trim());
  return rationale.length <= 6;
}

function deepEqual(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

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

test('review verdict cards keep the template field order and rationale within six lines', () => {
  assert.equal(hasValidVerdictCardFormat(validVerdictCard), true);
  assert.equal(hasValidVerdictCardFormat(validVerdictCard.replace(
    '- Status: 部分完成\n- Executor / Reviewer: developer / reviewer',
    '- Executor / Reviewer: developer / reviewer\n- Status: 部分完成'
  )), false, 'reordered headings are rejected');
  const sevenReasons = validVerdictCard.replace(
    '  - The rationale names the decisive acceptance criterion.',
    '  - Reason 2\n  - Reason 3\n  - Reason 4\n  - Reason 5\n  - Reason 6\n  - Reason 7'
  );
  assert.equal(hasValidVerdictCardFormat(sevenReasons), false, 'seven rationale lines are rejected');
  assert.match(prompt, /delivery-card fields in template order[\s\S]*Conclusion and scope of completion[\s\S]*at most 6 non-empty lines/i);
});
