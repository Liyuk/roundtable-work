import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateRouter } from '../../runtime/lib/fallback.mjs';
import { classify } from '../../runtime/lib/classify.mjs';

const TTL = 1000;
const candidates = {
  developer: [{ harness: 'pi', model: 'dev-pi' }, { harness: 'host-agent', model: 'dev-host' }],
  reviewer: [{ harness: 'host-agent', model: 'rev-host' }, { harness: 'pi', model: 'rev-pi' }],
};
const rate = () => Object.assign(new Error('too many requests'), { status: 429 });
const quota = () => ({ exitCode: 1, reason: 'budget_exhausted', output: '' });
const timeout = () => ({ exitCode: null, timedOut: true, output: '' });
const payment = () => Object.assign(new Error('insufficient balance'), { statusCode: 402 });
// Each preferred-candidate failure, thrown (429, 402) or returned as a classify-shaped event (quota, timeout).
const preferredFailures = { 429: rate, quota, timeout, 402: payment };

test('429, quota, timeout and 402 on the preferred candidate move to the next candidate at once', async () => {
  for (const [name, failure] of Object.entries(preferredFailures)) {
    const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => 0 });
    const calls = [];
    const result = await router('developer', (c) => {
      calls.push(c.model);
      if (c.model === 'dev-pi') { const f = failure(); if (f instanceof Error) throw f; return f; }
      return `ok:${c.model}`;
    });
    assert.equal(result, 'ok:dev-host', name);
    assert.deepEqual(calls, ['dev-pi', 'dev-host'], name);
  }
});

test('when every candidate is unavailable, the last failure is returned so classify() maps it to quota_wait, spending no developer retry', async () => {
  const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => 0 });
  const failure = quota();
  const result = await router('developer', (c) => (c.model === 'dev-pi' ? { ...failure, output: '' } : failure));
  const verdict = classify({ stage: 'developer', ...result });
  assert.deepEqual([verdict.class, verdict.decision, verdict.consumesDeveloperRetry], ['quota_wait', 'wait', false]);
});

test('a timeout with output is a code-side failure, not a candidate switch', async () => {
  const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => 0 });
  const calls = [];
  const result = await router('developer', (c) => { calls.push(c.model); return { exitCode: null, timedOut: true, output: 'partial work' }; });
  assert.deepEqual(calls, ['dev-pi']);
  assert.equal(classify({ stage: 'developer', ...result }).consumesDeveloperRetry, true);
});

test('a code failure with output does not switch candidates and spends a developer retry; a test failure does too', async () => {
  const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => 0 });
  const calls = [];
  const dev = await router('developer', (c) => { calls.push(c.model); return { exitCode: 1, output: 'AssertionError' }; });
  assert.deepEqual(calls, ['dev-pi']);
  assert.deepEqual([classify({ stage: 'developer', ...dev }).class, classify({ stage: 'developer', ...dev }).consumesDeveloperRetry], ['developer_failure', true]);
  const test_ = classify({ stage: 'test', exitCode: 1, output: 'FAIL' });
  assert.deepEqual([test_.class, test_.consumesDeveloperRetry], ['test_failure', true]);
});

test('quota with no output does not spend a developer retry, while code failure with output does', () => {
  assert.equal(classify({ stage: 'developer', exitCode: 1, reason: 'budget_exhausted', output: '' }).consumesDeveloperRetry, false);
  assert.equal(classify({ stage: 'developer', exitCode: 1, output: 'boom' }).consumesDeveloperRetry, true);
});

test('a reviewer candidate in the author session is skipped for the next valid candidate', async () => {
  const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => 0 });
  const calls = [];
  const result = await router('reviewer', (c) => { calls.push(c.model); return `ok:${c.model}`; }, { authorSession: 'host-agent' });
  assert.equal(result, 'ok:rev-pi');
  assert.deepEqual(calls, ['rev-pi']);
});

test('when the only reviewer candidate is the author session, the role is reported unavailable without running', async () => {
  const router = createCandidateRouter({ candidates: { reviewer: [{ harness: 'pi', model: 'rev-pi' }] }, ttlMs: TTL, now: () => 0 });
  const calls = [];
  const result = await router('reviewer', (c) => { calls.push(c.model); return 'ok'; }, { authorSession: 'pi' });
  assert.deepEqual(result, { unavailable: true });
  assert.deepEqual(calls, []);
});

test('an unavailability record names the candidate, the reason class, and retryAt from retryAfter in seconds or as an ISO time', async () => {
  let clock = 1000;
  const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => clock });
  await router('developer', (c) => { if (c.model === 'dev-pi') throw Object.assign(new Error('x'), { status: 429, retryAfter: 30 }); return 'ok'; });
  assert.deepEqual(router.unavailable().map(({ role, harness, model, reason, retryAt }) => ({ role, harness, model, reason, retryAt })), [
    { role: 'developer', harness: 'pi', model: 'dev-pi', reason: '429', retryAt: 31000 },
  ]);

  const iso = createCandidateRouter({ candidates, ttlMs: TTL, now: () => 0 });
  await iso('developer', (c) => { if (c.model === 'dev-pi') throw Object.assign(new Error('x'), { status: 429, retryAfter: '1970-01-01T00:00:05Z' }); return 'ok'; });
  assert.equal(iso.unavailable()[0].retryAt, 5000);
  const header = createCandidateRouter({ candidates, ttlMs: TTL, now: () => 0 });
  await header('developer', (c) => { if (c.model === 'dev-pi') throw Object.assign(new Error('x'), { status: 429, headers: { 'Retry-After': '7' } }); return 'ok'; });
  assert.equal(header.unavailable()[0].retryAt, 7000);
});

test('a candidate becomes available again at retryAt and is used by the next call', async () => {
  let clock = 0;
  const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => clock });
  const invoke = (c) => (c.model === 'dev-pi' && clock < 5000 ? (() => { throw Object.assign(new Error('x'), { status: 429, retryAfter: 5 }); })() : `ok:${c.model}`);
  assert.equal(await router('developer', invoke), 'ok:dev-host');
  clock = 4999;
  assert.equal(await router('developer', invoke), 'ok:dev-host');
  clock = 5000;
  assert.equal(await router('developer', invoke), 'ok:dev-pi');
});

test('one harness limited does not block another role on a different harness', async () => {
  const split = {
    developer: [{ harness: 'pi', model: 'dev-pi' }],
    reviewer: [{ harness: 'host-agent', model: 'rev-host' }],
  };
  const router = createCandidateRouter({ candidates: split, ttlMs: TTL, now: () => 0 });
  const limited = await router('developer', () => { throw rate(); }).catch((error) => error);
  assert.equal(limited.status, 429);
  assert.equal(classify({ stage: 'developer', ...limited }).class, 'quota_wait');
  assert.equal(await router('reviewer', (c) => `ok:${c.model}`), 'ok:rev-host');
});

test('unavailableStats counts cycles with no candidate available and the wall time until one recovers', async () => {
  let clock = 100;
  const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => clock });
  const down = () => { throw rate(); };
  await router('developer', down).catch(() => {});
  clock = 400;
  await router('developer', down).catch(() => {});
  assert.deepEqual(router.unavailableStats('developer'), { cycles: 2, wallMs: 300 });
  clock = 1500;
  assert.equal(await router('developer', (c) => `ok:${c.model}`), 'ok:dev-pi');
  assert.deepEqual(router.unavailableStats('developer'), { cycles: 2, wallMs: 1400 });
});
