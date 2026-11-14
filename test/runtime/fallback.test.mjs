import test from 'node:test';
import assert from 'node:assert/strict';
import { createFallbackRouter, waitForUsageLimit } from '../../runtime/lib/fallback.mjs';

const routes = {
  developer: { harness: 'pi', model: 'primary-dev' },
  reviewer: { harness: 'pi', model: 'primary-review' },
  chief: { harness: 'other', model: 'other-primary' },
};
const fallback = { pi: 'fallback-pi', other: 'fallback-other' };
const balanceError = () => Object.assign(new Error('insufficient balance'), { status: 402 });

test('a 402 on the primary model re-runs once on the fallback, then returns to primary after the TTL', async () => {
  let clock = 0;
  const router = createFallbackRouter({ routes, fallback, ttlMs: 1000, now: () => clock });
  const calls = [];
  let failNextPrimary = true;
  const invoke = (model) => {
    calls.push(model);
    if (model === 'primary-dev' && failNextPrimary) { failNextPrimary = false; throw balanceError(); }
    return `ok:${model}`;
  };

  assert.equal(await router('developer', invoke), 'ok:fallback-pi');
  assert.deepEqual(calls, ['primary-dev', 'fallback-pi']);

  calls.length = 0;
  clock = 500;
  assert.equal(await router('reviewer', invoke), 'ok:fallback-pi');
  assert.deepEqual(calls, ['fallback-pi']);

  calls.length = 0;
  clock = 1000;
  assert.equal(await router('developer', invoke), 'ok:primary-dev');
  assert.deepEqual(calls, ['primary-dev']);
});

test('a fallback call that also fails with 402 propagates without a further retry', async () => {
  const router = createFallbackRouter({ routes, fallback, ttlMs: 1000, now: () => 0 });
  const calls = [];
  await assert.rejects(router('developer', (model) => { calls.push(model); throw balanceError(); }), { status: 402 });
  assert.deepEqual(calls, ['primary-dev', 'fallback-pi']);
});

test('non-402 errors propagate unchanged and switch nothing', async () => {
  const router = createFallbackRouter({ routes, fallback, ttlMs: 1000, now: () => 0 });
  const failure = new Error('boom');
  const calls = [];
  await assert.rejects(router('developer', (model) => { calls.push(model); throw failure; }), (error) => error === failure);
  assert.deepEqual(calls, ['primary-dev']);
  calls.length = 0;
  await router('reviewer', (model) => { calls.push(model); return 'ok'; });
  assert.deepEqual(calls, ['primary-review']);
});

test('statusCode 402 is treated as a balance error', async () => {
  const router = createFallbackRouter({ routes, fallback, ttlMs: 1000, now: () => 0 });
  const calls = [];
  const result = await router('chief', (model) => {
    calls.push(model);
    if (calls.length === 1) throw Object.assign(new Error('x'), { statusCode: 402 });
    return 'done';
  });
  assert.equal(result, 'done');
  assert.deepEqual(calls, ['other-primary', 'fallback-other']);
});

test('usage-limit wait runs the main-CI check at least once and ends when now() reaches until', async () => {
  let clock = 0;
  let checks = 0;
  const sleeps = [];
  await waitForUsageLimit({
    until: 2500,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    intervalMs: 1000,
    checkMainCi: async () => { checks += 1; },
  });
  assert.equal(clock >= 2500, true);
  assert.equal(checks >= 1, true);
  assert.deepEqual(sleeps, [1000, 1000, 1000]);
});

test('usage-limit wait still checks main CI once when the limit has already passed', async () => {
  let checks = 0;
  await waitForUsageLimit({ until: 0, now: () => 10, sleep: async () => {}, intervalMs: 1000, checkMainCi: async () => { checks += 1; } });
  assert.equal(checks, 1);
});
