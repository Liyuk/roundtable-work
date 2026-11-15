import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, createAdapterLauncher } from '../../runtime/lib/agent-adapter.mjs';
import { loadUsageLedger, recordUsageRow } from '../../runtime/lib/usage-ledger.mjs';
import { detectStalls } from '../../runtime/lib/stall.mjs';

const dirs = [];
async function tempWorkRoot() {
  const dir = await mkdtemp(join(tmpdir(), 'rt-usage-'));
  dirs.push(dir);
  await mkdir(join(dir, 'state'));
  return dir;
}

// Fake child process: emits `stdoutText` on stdout, then exits with `code` (exit, then close, as Node does).
const fakeSpawn = (stdoutText, code = 0) => () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdoutText));
    child.emit('exit', code);
    child.emit('close', code);
  });
  return child;
};

const codexOutput = [
  { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
].map((e) => JSON.stringify(e)).join('\n');

test('launcher records one row per call; unknown usage gives usageKnown false and null tokens', async () => {
  const workRoot = await tempWorkRoot();
  const calls = [];
  const record = (row) => { calls.push(row); return recordUsageRow(workRoot, row); };
  const meta = { issue: '336', role: 'developer', model: 'm-under-test' };
  const known = createAdapterLauncher({ adapter: ADAPTERS.codex, command: 'codex-bin', spawnFn: fakeSpawn(codexOutput), recordUsage: record });
  const unknown = createAdapterLauncher({ adapter: ADAPTERS.pi, command: 'pi-bin', spawnFn: fakeSpawn('plain text'), recordUsage: record });
  assert.equal(await known({ workspace: '.', sessionId: 's', resume: false, prompt: 'p', ...meta }), 0);
  assert.equal(await unknown({ workspace: '.', sessionId: 's', resume: false, prompt: 'p', ...meta }), 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ issue, role, harness, model, usageKnown, inputTokens, cachedInputTokens, outputTokens }) => ({ issue, role, harness, model, usageKnown, inputTokens, cachedInputTokens, outputTokens })),
    [
      { issue: '336', role: 'developer', harness: 'codex', model: 'm-under-test', usageKnown: true, inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 },
      { issue: '336', role: 'developer', harness: 'pi', model: 'm-under-test', usageKnown: false, inputTokens: null, cachedInputTokens: null, outputTokens: null },
    ],
  );
  assert.equal(typeof calls[0].wallMs, 'number');
  assert.equal(typeof calls[0].at, 'number');
  await rm(workRoot, { recursive: true, force: true });
});

test('launcher without recordUsage keeps the original stdio (stdout inherited, no capture)', async () => {
  let stdio;
  const spawnFn = (command, args, options) => { stdio = options.stdio; return fakeSpawn('')(); };
  const launch = createAdapterLauncher({ adapter: ADAPTERS.pi, command: 'pi-bin', spawnFn });
  await launch({ workspace: '.', sessionId: 's', resume: false, prompt: 'p' });
  assert.deepEqual(stdio, ['ignore', 'inherit', 'inherit']);
});

test('persisted usage rows reload in a fresh call and tokens-no-commit fires from them', async () => {
  const workRoot = await tempWorkRoot();
  const record = (row) => recordUsageRow(workRoot, row);
  const meta = { issue: '336', role: 'developer', model: 'm' };
  const launch = createAdapterLauncher({ adapter: ADAPTERS.codex, command: 'codex-bin', spawnFn: fakeSpawn(codexOutput), recordUsage: record });
  // Each call reports 100 input + 7 output tokens; the 500000 threshold is reached only after persisted rows add up.
  const big = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 499000, cached_input_tokens: 0, output_tokens: 1000 } });
  const bigLaunch = createAdapterLauncher({ adapter: ADAPTERS.codex, command: 'codex-bin', spawnFn: fakeSpawn(big), recordUsage: record });
  await launch({ workspace: '.', sessionId: 's', resume: false, prompt: 'p', ...meta });
  await bigLaunch({ workspace: '.', sessionId: 's', resume: false, prompt: 'p', ...meta });

  const reloaded = await loadUsageLedger(workRoot, '336');
  assert.equal(reloaded.rows.length, 2);
  const committedAfter = detectStalls({ events: [{ type: 'commit', at: Date.now() + 60000, sha: 'c1' }], now: Date.now() + 60001, ledger: reloaded, issue: '336' });
  assert.deepEqual(committedAfter.map((s) => s.signal), []);
  const spent = detectStalls({ events: [{ type: 'commit', at: Date.now() - 60000, sha: 'c0' }], now: Date.now(), ledger: reloaded, issue: '336' });
  assert.deepEqual(spent.map((s) => s.signal), ['tokens-no-commit']);
  assert.equal(spent[0].evidence.spent, 499000 + 1000 + 100 + 7);
  await rm(workRoot, { recursive: true, force: true });
});
