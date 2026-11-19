import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { loadE2eConfig } from '../../runtime/lib/pipeline.mjs';

const HEAD = 'a'.repeat(40);

// Runs one pass over issue 7 with an injected e2e exec; `e2eResults` answers the e2e runs in order, then passes.
async function run({ e2eConfig, e2eResults = [] } = {}) {
  const root = await mkdtemp(join(process.cwd(), 'rt602-test-'));
  const phases = [];
  const execCalls = [];
  const handler = async ({ phase }) => {
    phases.push(phase);
    return { exitCode: 0, output: phase === 'reviewing' ? 'Verdict: pass' : 'ok' };
  };
  const e2eExec = async (command, opts) => { execCalls.push([command, opts]); return e2eResults.shift() ?? { code: 0, timedOut: false }; };
  try {
    const result = await runQueue({ workRoot: root, queue: ['7'], handler, e2eConfig, e2eExec });
    const state = await (await createStateStore({ workRoot: root })).load('7');
    return { result, phases, execCalls, state };
  } finally { await rm(root, { recursive: true, force: true }); }
}

const ONE_PASS = ['developing', 'testing', 'reviewing', 'finalizing'];
const RETRY_THEN_PASS = ['developing', 'testing', 'reviewing', 'developing', 'testing', 'reviewing', 'finalizing'];

test('the e2e config file is default off: no command', async () => {
  assert.equal((await loadE2eConfig()).e2e.command, null);
});

test('without e2e.command the review pass goes to accept and records e2e:not-configured', async () => {
  const { phases, execCalls, state, result } = await run();
  assert.deepEqual(phases, ONE_PASS);
  assert.deepEqual(execCalls, []);
  assert.equal(state.ledger.find((entry) => entry.id === 'e2e')?.detail, 'e2e:not-configured');
  assert.equal(result.outcomes[0].status, 'done');
});

test('with e2e.command a passing run on the final head continues to accept', async () => {
  const { phases, execCalls, state, result } = await run({ e2eConfig: { e2e: { command: 'npm run e2e', timeoutMs: 1000 } } });
  assert.deepEqual(phases, ONE_PASS);
  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0][0], 'npm run e2e');
  assert.equal(execCalls[0][1].head, HEAD);
  assert.equal(execCalls[0][1].timeoutMs, 1000);
  assert.equal(state.ledger.some((entry) => entry.id === 'e2e'), false);
  assert.equal(result.outcomes[0].status, 'done');
});

test('a failing e2e run returns the line to execute', async () => {
  const { phases, execCalls, state, result } = await run({
    e2eConfig: { e2e: { command: 'npm run e2e', timeoutMs: 1000 } },
    e2eResults: [{ code: 1, timedOut: false }],
  });
  assert.deepEqual(phases, RETRY_THEN_PASS);
  assert.equal(execCalls.length, 2);
  assert.equal(state.attempts.developer, 1);
  assert.equal(result.outcomes[0].status, 'done');
});

test('a timed-out e2e run returns the line to execute', async () => {
  const { phases, state } = await run({
    e2eConfig: { e2e: { command: 'npm run e2e', timeoutMs: 1000 } },
    e2eResults: [{ code: null, timedOut: true }],
  });
  assert.deepEqual(phases, RETRY_THEN_PASS);
  assert.equal(state.attempts.developer, 1);
});
