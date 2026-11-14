import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';

// Runtime lock records live in a private anchor, as in recovery.test.mjs.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-rework-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* harmless */ } });
const tmp = () => mkdtemp(join(tmpdir(), 'rt-rework-'));
const REJECT = '审查结论：打回\nneeds rework';
const PASS = '审查结论：通过\nok';
const QUICK = { lockRenewMinMs: 20 };
const role = (harness, model) => ({ harness, model, tier: 'standard' });
const routingWith = (roles) => ({ facts: { window: 'test', roles }, prompts: {} });
const ALL = { chief: role('h', 'm-chief'), developer: role('h', 'm-dev'), fixer: role('h', 'm-fix'), reviewer: role('h', 'm-rev'), researcher: role('h', 'm-res'), crosscheck: role('h', 'm-cc') };

test('a review rejection reruns development with the fixer role, never chief', async () => {
  const root = await tmp();
  try {
    const developing = [];
    const handler = async ({ phase, role: implementer }) => {
      if (phase === 'developing') developing.push(implementer);
      return { exitCode: 0, output: phase === 'reviewing' && developing.length === 1 ? REJECT : phase === 'reviewing' ? PASS : 'ok' };
    };
    const result = await runQueue({ workRoot: root, queue: ['1'], handler, routing: routingWith(ALL), ...QUICK });
    assert.deepEqual(developing, ['developer', 'fixer']);
    assert.equal(result.outcomes[0].status, 'done');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a review rejection falls back to the developer role when fixer is not configured', async () => {
  const root = await tmp();
  try {
    const developing = [];
    const handler = async ({ phase, role: implementer }) => {
      if (phase === 'developing') developing.push(implementer);
      return { exitCode: 0, output: phase === 'reviewing' && developing.length === 1 ? REJECT : phase === 'reviewing' ? PASS : 'ok' };
    };
    const { fixer, ...roles } = ALL;
    await runQueue({ workRoot: root, queue: ['1'], handler, routing: routingWith(roles), ...QUICK });
    assert.deepEqual(developing, ['developer', 'developer']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Chief-authored development result is refused fail-closed as scope_mismatch without spending a retry', async () => {
  const root = await tmp();
  try {
    let calls = 0;
    const handler = async ({ phase }) => { if (phase === 'developing') calls++; return { exitCode: 0, output: 'ok', author: 'chief' }; };
    const result = await runQueue({ workRoot: root, queue: ['1'], handler, routing: routingWith(ALL), ...QUICK });
    assert.equal(calls, 1);
    assert.equal(result.outcomes[0].class, 'scope_mismatch');
    assert.equal(result.outcomes[0].decision, 'ask');
    assert.notEqual(result.outcomes[0].status, 'done');
    const state = await (await createStateStore({ workRoot: root })).load('1');
    assert.equal(state.attempts.developer, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('without a configured implementer the run stops with no_implementer_configured and never calls the handler', async () => {
  const root = await tmp();
  try {
    let calls = 0;
    const handler = async () => { calls++; return { exitCode: 0, output: 'ok' }; };
    const roles = { ...ALL, developer: { harness: '', model: '' }, fixer: { harness: 'h' } };
    const result = await runQueue({ workRoot: root, queue: ['1'], handler, routing: routingWith(roles), ...QUICK });
    assert.equal(calls, 0);
    assert.deepEqual([result.outcomes[0].status, result.outcomes[0].reason, result.outcomes[0].decision], ['stop', 'no_implementer_configured', 'stop']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
