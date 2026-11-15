import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGES, nextStage, parsePlan, executeGate, runE2e, ledgerEntry } from '../../runtime/lib/pipeline.mjs';

const plan = { approach: 'small change', files: ['a.mjs'], risks: [], tests: ['t'] };
const fenced = json => ['Plan:', '```rt-plan', json, '```'].join('\n');
const none = { decomposeTriggered: false, reviewPassed: true, e2eConfigured: false, e2ePassed: false };

test('stages are frozen and ordered', () => {
  assert.deepEqual(STAGES, ['design', 'plan', 'decompose', 'goal', 'execute', 'review', 'e2e', 'accept']);
  assert.ok(Object.isFrozen(STAGES));
});

test('design and plan advance along the pipeline', () => {
  assert.deepEqual(nextStage({ stage: 'design' }, none), { stage: 'plan' });
  assert.deepEqual(nextStage({ stage: 'plan' }, { ...none, decomposeTriggered: true }), { stage: 'decompose' });
});

test('decompose is skipped with a recorded reason when not triggered', () => {
  assert.deepEqual(nextStage({ stage: 'plan' }, none), { stage: 'goal', skipped: 'decompose:no-trigger' });
  assert.deepEqual(nextStage({ stage: 'decompose' }, none), { stage: 'goal' });
});

test('goal and execute advance along the pipeline', () => {
  assert.deepEqual(nextStage({ stage: 'goal' }, none), { stage: 'execute' });
  assert.deepEqual(nextStage({ stage: 'execute' }, none), { stage: 'review' });
});

test('review failure goes back to execute', () => {
  assert.deepEqual(nextStage({ stage: 'review' }, { ...none, reviewPassed: false, e2eConfigured: true }), { stage: 'execute' });
});

test('review pass goes to e2e when configured, otherwise to accept with a recorded skip', () => {
  assert.deepEqual(nextStage({ stage: 'review' }, { ...none, e2eConfigured: true }), { stage: 'e2e' });
  assert.deepEqual(nextStage({ stage: 'review' }, none), { stage: 'accept', skipped: 'e2e:not-configured' });
});

test('e2e pass goes to accept and e2e failure goes back to execute', () => {
  assert.deepEqual(nextStage({ stage: 'e2e' }, { ...none, e2eConfigured: true, e2ePassed: true }), { stage: 'accept' });
  assert.deepEqual(nextStage({ stage: 'e2e' }, { ...none, e2eConfigured: true, e2ePassed: false }), { stage: 'execute' });
});

test('accept is terminal', () => {
  assert.deepEqual(nextStage({ stage: 'accept' }, none), { stage: null });
});

test('parsePlan accepts a valid rt-plan block', () => {
  assert.deepEqual(parsePlan(fenced(JSON.stringify(plan))), plan);
  assert.deepEqual(parsePlan(fenced(JSON.stringify({ ...plan, files: [], risks: [], tests: [] }))), { ...plan, files: [], risks: [], tests: [] });
});

test('parsePlan rejects missing, malformed or incomplete plans', () => {
  assert.equal(parsePlan('no plan here'), null);
  assert.equal(parsePlan(fenced('{not json')), null);
  assert.equal(parsePlan(fenced('null')), null);
  assert.equal(parsePlan(fenced(JSON.stringify({ ...plan, approach: '' }))), null);
  assert.equal(parsePlan(fenced(JSON.stringify({ ...plan, approach: 3 }))), null);
  assert.equal(parsePlan(fenced(JSON.stringify({ ...plan, files: 'a.mjs' }))), null);
  assert.equal(parsePlan(fenced(JSON.stringify({ approach: 'x', files: [], risks: [] }))), null);
});

test('executeGate re-asks once on a missing plan, then degrades to execute', () => {
  assert.deepEqual(executeGate('no plan', { reasked: false }), { action: 're-ask' });
  assert.deepEqual(executeGate('no plan', { reasked: true }), { action: 'execute', degraded: true });
});

test('executeGate proceeds normally with a valid plan', () => {
  assert.deepEqual(executeGate(fenced(JSON.stringify(plan)), { reasked: false }), { action: 'execute', plan });
});

test('runE2e runs the configured command on the head and reports success', async () => {
  const calls = [];
  const exec = async (command, opts) => { calls.push([command, opts]); return { code: 0, timedOut: false }; };
  const config = { e2e: { command: 'npm run e2e', timeoutMs: 1000 } };
  assert.deepEqual(await runE2e({ exec, head: 'abc', config }), { ok: true });
  assert.deepEqual(calls, [['npm run e2e', { timeoutMs: 1000, head: 'abc' }]]);
});

test('runE2e reports a non-zero exit as a failure', async () => {
  const exec = async () => ({ code: 1, timedOut: false });
  assert.deepEqual(await runE2e({ exec, head: 'abc', config: { e2e: { command: 'x' } } }), { ok: false });
});

test('runE2e reports a timeout as a failure', async () => {
  const exec = async () => ({ code: null, timedOut: true });
  assert.deepEqual(await runE2e({ exec, head: 'abc', config: { e2e: { command: 'x', timeoutMs: 5 } } }), { ok: false });
});

test('runE2e skips when e2e is not configured', async () => {
  const exec = async () => assert.fail('must not run');
  assert.deepEqual(await runE2e({ exec, head: 'abc', config: {} }), { skipped: 'e2e:not-configured' });
});

test('ledgerEntry records a stage change with the injected timestamp and role', () => {
  assert.deepEqual(
    ledgerEntry({ from: 'review', to: 'e2e', at: '2026-11-15T12:00:00.000Z', role: 'developer' }),
    { stage: 'e2e', from: 'review', at: '2026-11-15T12:00:00.000Z', role: 'developer' },
  );
});
