import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { runQueue } from './observation-fixture.mjs';

const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-reask-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const PASS = '审查结论：通过\nok';
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'rt-reask-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
// Finalizing returns decisions from `answers` in order; every other phase passes.
function handlerWith(answers, calls) {
  return async ({ phase, reask }) => {
    calls.push({ phase, reask });
    if (phase === 'reviewing') return { exitCode: 0, output: PASS };
    if (phase === 'finalizing') return answers.shift();
    return { exitCode: 0, output: 'ok' };
  };
}

test('an unparsable finalizing DECISION gets one same-session re-ask that spends no wake', () => withRoot(async root => {
  const calls = [];
  const handler = handlerWith([{ exitCode: 0, decisionFile: 'continue, probably' }, { exitCode: 0, decisionFile: 'DECISION=continue\nKeep going' }], calls);
  const result = await runQueue({ workRoot: root, queue: ['1'], handler });
  assert.equal(result.outcomes[0].status, 'queued');
  assert.equal(result.outcomes[0].decision, 'continue');
  const finalizing = calls.filter(call => call.phase === 'finalizing');
  assert.equal(finalizing.length, 2);
  assert.equal(finalizing[0].reask, undefined);
  assert.match(finalizing[1].reask.prompt, /only the decision file/);
  assert.equal((await (await createStateStore({ workRoot: root })).load('1')).attempts.wakes, 1);
}));

test('an unparsable DECISION is re-asked once; a second failure follows the existing rejection path', () => withRoot(async root => {
  const calls = [];
  const handler = handlerWith([{ exitCode: 0, decisionFile: 'DECISION=merge\nNo' }, { exitCode: 0, decisionFile: 'DECISION=merge\nStill no' }], calls);
  await assert.rejects(runQueue({ workRoot: root, queue: ['2'], handler }), /decision file must start with/);
  assert.equal(calls.filter(call => call.phase === 'finalizing').length, 2);
  const state = await (await createStateStore({ workRoot: root })).load('2');
  assert.equal(state.attempts.wakes, 1);
  assert.notEqual(state.status, 'waiting_person');
}));

test('a valid DECISION on the first answer is never re-asked', () => withRoot(async root => {
  const calls = [];
  const handler = handlerWith([{ exitCode: 0, decisionFile: 'DECISION=continue\nKeep going' }], calls);
  assert.equal((await runQueue({ workRoot: root, queue: ['3'], handler })).outcomes[0].status, 'queued');
  assert.equal(calls.filter(call => call.phase === 'finalizing').length, 1);
}));

test('a failed finalizing step is not re-asked', () => withRoot(async root => {
  const calls = [];
  const handler = handlerWith([{ exitCode: 1, output: 'boom' }], calls);
  const result = await runQueue({ workRoot: root, queue: ['4'], handler });
  assert.equal(result.outcomes[0].class, 'finalize_failure');
  assert.equal(calls.filter(call => call.phase === 'finalizing').length, 1);
}));
