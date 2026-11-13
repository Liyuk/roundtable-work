import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRouter, escalationAttemptBudget } from '../../runtime/lib/routing.mjs';

const env = {
  RT_MODEL: 'vendor/standard-7',
  RT_REVIEWER_MODEL: 'vendor/reviewer-7',
  RT_DECIDER_MODEL: 'vendor/escalation-7',
  RT_CROSSCHECK_MODEL: 'vendor/audit-7',
  RT_ALLOWED_MODELS: 'vendor/standard-7,vendor/reviewer-7,vendor/escalation-7,vendor/audit-7',
};

test('routes each work type through its configured model', () => {
  const route = createModelRouter(env);
  assert.deepEqual(Object.fromEntries(['chief', 'development', 'review', 'verification', 'escalation', 'cross-check'].map(type => [type, route(type)])), {
    chief: 'vendor/standard-7', development: 'vendor/standard-7', review: 'vendor/reviewer-7',
    verification: 'vendor/standard-7', escalation: 'vendor/escalation-7', 'cross-check': 'vendor/audit-7',
  });
});

test('rejects malformed or missing configured model routes', () => {
  assert.throws(() => createModelRouter({ ...env, RT_DECIDER_MODEL: 'not a model' }), /RT_DECIDER_MODEL/);
  assert.throws(() => createModelRouter({ ...env, RT_CROSSCHECK_MODEL: '' }), /RT_CROSSCHECK_MODEL/);
});

test('rejects syntactically valid but unknown model identifiers', () => {
  assert.throws(() => createModelRouter({ ...env, RT_DECIDER_MODEL: 'garbage' }), /RT_DECIDER_MODEL/);
  assert.throws(() => createModelRouter({ ...env, RT_ALLOWED_MODELS: 'not a model' }), /RT_ALLOWED_MODELS/);
});

test('accepts the current deployment models without extra configuration', () => {
  const route = createModelRouter({ RT_MODEL: 'gpt-6-luna', RT_REVIEWER_MODEL: 'deepseek-v4-pro',
    RT_DECIDER_MODEL: 'gpt-6.1-terra', RT_CROSSCHECK_MODEL: 'gpt-6.1-terra' });
  assert.equal(route('chief'), 'gpt-6-luna');
  assert.equal(route('review'), 'deepseek-v4-pro');
  assert.equal(route('escalation'), 'gpt-6.1-terra');
});

test('rejects unknown work types instead of silently selecting a route', () => {
  const route = createModelRouter(env);
  assert.throws(() => route('deployment'), /work type/);
});

test('reads and validates the durable escalation attempt budget', () => {
  assert.equal(escalationAttemptBudget({ RT_DECIDE_MAX: '3' }), 3);
  assert.equal(escalationAttemptBudget({}), 2);
  assert.throws(() => escalationAttemptBudget({ RT_DECIDE_MAX: '0' }), /RT_DECIDE_MAX/);
});
