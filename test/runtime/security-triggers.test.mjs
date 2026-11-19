import test from 'node:test';
import assert from 'node:assert/strict';
import { securityTriggers } from '../../runtime/lib/security-triggers.mjs';
import { gate2Triggers } from '../../runtime/lib/gate2-triggers.mjs';

const RATIONALE = 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.';

test('auth paths trigger security', () => {
  assert.equal(securityTriggers(['runtime/lib/auth-check.mjs']), true);
});

test('network paths trigger security', () => {
  assert.equal(securityTriggers(['runtime/lib/http-client.mjs']), true);
});

test('secrets paths trigger security', () => {
  assert.equal(securityTriggers(['config/.env.example']), true);
});

test('external input paths trigger security', () => {
  assert.equal(securityTriggers(['runtime/lib/intake-parser.mjs']), true);
});

test('deployment paths trigger security', () => {
  assert.equal(securityTriggers(['deploy/rt.service']), true);
});

test('docs and unrelated files do not trigger security', () => {
  assert.equal(securityTriggers(['docs/17-model-routing.md', 'runtime/lib/gates.mjs']), false);
  assert.equal(securityTriggers([]), false);
});

test('gate2Triggers adds security only for trigger paths', () => {
  const gate1 = { rationale: RATIONALE };
  assert.deepEqual(gate2Triggers({ changedFiles: ['runtime/lib/auth-check.mjs'], gate1 }), ['security']);
  assert.deepEqual(gate2Triggers({ changedFiles: ['docs/17-model-routing.md'], gate1 }), []);
});
