import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { planGateEnabled } from '../../runtime/lib/pipeline.mjs';

const plan = { approach: 'small change', files: ['a.mjs'], risks: [], tests: ['t'] };
const fenced = json => ['Plan:', '```rt-plan', json, '```'].join('\n');

// Runs one pass over issue 7. `outputs` answers the plan turns in order; every other phase succeeds.
async function run({ outputs = [], planGate } = {}) {
  const root = await mkdtemp(join(process.cwd(), 'rt601-test-'));
  const calls = [];
  const handler = async ({ phase, plan: planTurn }) => {
    calls.push({ phase, plan: planTurn?.prompt ?? null });
    if (planTurn) return { exitCode: 0, output: outputs.shift() ?? '' };
    return { exitCode: 0, output: phase === 'reviewing' ? 'Verdict: pass' : 'ok' };
  };
  try {
    const result = await runQueue({ workRoot: root, queue: ['7'], handler, ...(planGate === undefined ? {} : { planGate }) });
    const state = await (await createStateStore({ workRoot: root })).load('7');
    return { result, calls, state };
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('the plan gate is default off in the config file', async () => {
  assert.equal(await planGateEnabled(), false);
});

test('with the gate off, execute runs without a plan turn and records no plan', async () => {
  const { calls, state } = await run({ planGate: false });
  assert.ok(calls.some(c => c.phase === 'developing'));
  assert.equal(calls.some(c => c.plan), false);
  assert.equal(state.plan, undefined);
});

test('a valid rt-plan is recorded before execute starts', async () => {
  const { calls, state } = await run({ planGate: true, outputs: [fenced(JSON.stringify(plan))] });
  assert.deepEqual(calls.slice(0, 2).map(c => c.plan !== null), [true, false]);
  assert.equal(calls[0].phase, 'developing');
  assert.deepEqual(state.plan, plan);
});

test('an invalid plan re-asks once and a valid re-ask is recorded', async () => {
  const { calls, state } = await run({ planGate: true, outputs: ['no plan here', fenced(JSON.stringify(plan))] });
  assert.equal(calls.filter(c => c.plan).length, 2);
  assert.notEqual(calls[1].plan, calls[0].plan);
  assert.equal(calls[2].plan, null);
  assert.deepEqual(state.plan, plan);
});

test('a plan still invalid after the re-ask degrades and execute still runs', async () => {
  const { calls, state, result } = await run({ planGate: true, outputs: ['no plan', fenced('{not json')] });
  assert.equal(calls.filter(c => c.plan).length, 2);
  assert.ok(calls.some(c => c.phase === 'developing' && c.plan === null));
  assert.deepEqual(state.plan, { degraded: true });
  assert.notEqual(result.outcomes[0].decision, 'stop');
  assert.notEqual(result.outcomes[0].decision, 'ask');
});
