import test from 'node:test';
import assert from 'node:assert/strict';
import { decomposeTriggers } from '../../runtime/lib/decompose-triggers.mjs';
import { reworkAction, triageDecision } from '../../runtime/lib/decisions.mjs';

const large = { size: 401 };
const many = { acceptance: 9 };

test('each trigger fires alone', () => {
  assert.deepEqual(decomposeTriggers({ size: 401 }), ['size']);
  assert.deepEqual(decomposeTriggers({ acceptance: 9 }), ['acceptance']);
  assert.deepEqual(decomposeTriggers({ threatModel: true }), ['threat-model']);
  assert.deepEqual(decomposeTriggers({ safetyFiles: true }), ['safety-files']);
  assert.deepEqual(decomposeTriggers({ dataModel: true }), ['data-model']);
});

test('no trigger at or below the thresholds', () => {
  assert.deepEqual(decomposeTriggers({ size: 400, acceptance: 8 }), []);
  assert.deepEqual(decomposeTriggers({}), []);
});

test('thresholds are configurable', () => {
  assert.deepEqual(decomposeTriggers({ size: 150 }, { sizeLimit: 100 }), ['size']);
  assert.deepEqual(decomposeTriggers({ acceptance: 3 }, { acceptanceLimit: 2 }), ['acceptance']);
});

test('triage derives size, acceptance and risk from the issue body', () => {
  const body = [
    '## Size estimate', 'Changed lines: 500', '',
    '## Acceptance criteria', '- one', '- two', '',
    '## Notes', 'Touches the threat model.',
  ].join('\n');
  assert.deepEqual(triageDecision({ body }), { decision: 'decompose', triggers: ['size', 'threat-model'] });
});

test('triage stays silent for a small issue without risk markers', () => {
  const body = '## Size estimate\nChanged lines: 120\n\n## Acceptance criteria\n1. one\n2. two\n';
  assert.equal(triageDecision({ body }), null);
});

test('depth cap: triage returns null once depth reaches maxDepth', () => {
  assert.equal(triageDecision({ ...large, depth: 2 }), null);
  assert.deepEqual(triageDecision({ ...large, depth: 1 }), { decision: 'decompose', triggers: ['size'] });
  assert.equal(triageDecision({ ...large, depth: 1, maxDepth: 1 }), null);
});

test('a body with a Parent line starts at depth 1', () => {
  const body = 'Parent: #330\n\n## Size estimate\nChanged lines: 500\n';
  assert.equal(triageDecision({ body })?.decision, 'decompose');
  assert.equal(triageDecision({ body, maxDepth: 1 }), null);
});

test('second gate failure on a large issue produces decompose', () => {
  assert.deepEqual(reworkAction({ failures: 2, ...large }), { action: 'decompose', triggers: ['size'] });
  assert.deepEqual(reworkAction({ failures: 2, ...many }), { action: 'decompose', triggers: ['acceptance'] });
});

test('second gate failure on a small issue keeps the fix round', () => {
  assert.deepEqual(reworkAction({ failures: 2, size: 10 }), { action: 'fix-round' });
  assert.deepEqual(reworkAction({ failures: 1, ...large }), { action: 'fix-round' });
});

test('second gate failure at the depth cap keeps the fix round', () => {
  assert.deepEqual(reworkAction({ failures: 2, ...large, depth: 2 }), { action: 'fix-round' });
});
