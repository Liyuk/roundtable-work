import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceOutcome,
  assertIndependentVerifier,
  nextAfterVerification,
  verifierInput,
} from '../../runtime/lib/verify.mjs';

test('verifier input is exactly the acceptance criteria and the artifact reference', () => {
  const input = verifierInput({ acceptanceCriteria: ['tests pass'], artifact: 'branch rt/561-pi', developerTranscript: 'secret' });
  assert.deepEqual(input, { acceptanceCriteria: ['tests pass'], artifact: 'branch rt/561-pi' });
});

test('verifier input rejects empty or malformed criteria and artifact', () => {
  assert.throws(() => verifierInput({ acceptanceCriteria: [], artifact: 'a' }), TypeError);
  assert.throws(() => verifierInput({ acceptanceCriteria: ['ok', ''], artifact: 'a' }), TypeError);
  assert.throws(() => verifierInput({ acceptanceCriteria: 'ok', artifact: 'a' }), TypeError);
  assert.throws(() => verifierInput({ acceptanceCriteria: ['ok'], artifact: '' }), TypeError);
});

test('reusing the developer session is rejected; distinct sessions pass', () => {
  assert.throws(() => assertIndependentVerifier({ developerSession: 's1', verifierSession: 's1' }), TypeError);
  assert.throws(() => assertIndependentVerifier({ developerSession: 's1', verifierSession: '' }), TypeError);
  assert.throws(() => assertIndependentVerifier({ developerSession: undefined, verifierSession: 's2' }), TypeError);
  assert.doesNotThrow(() => assertIndependentVerifier({ developerSession: 's1', verifierSession: 's2' }));
});

test('only pass with evidence for every criterion accepts', () => {
  assert.equal(acceptanceOutcome({ verdict: 'pass', evidence: ['ran npm test: exit 0', 'read diff'] }), 'accepted');
  assert.equal(acceptanceOutcome({ verdict: 'pass', evidence: ['ran npm test: exit 0', ''] }), 'not-accepted');
  assert.equal(acceptanceOutcome({ verdict: 'pass', evidence: [] }), 'not-accepted');
});

test('inconclusive is never a pass, even with green CI evidence', () => {
  assert.equal(acceptanceOutcome({ verdict: 'inconclusive', evidence: ['CI green'] }), 'not-accepted');
  assert.equal(acceptanceOutcome({ verdict: 'reject', evidence: ['CI green'] }), 'not-accepted');
});

test('reject or inconclusive defaults to sequential fix then verify', () => {
  assert.deepEqual(nextAfterVerification('accepted'), { action: 'accept' });
  assert.deepEqual(nextAfterVerification('not-accepted'), { action: 'fix', then: 'verify' });
});
