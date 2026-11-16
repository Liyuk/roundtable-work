import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectHarness, HARNESSES } from '../../runtime/lib/harness.mjs';
import { createAdapterLauncher } from '../../runtime/lib/agent-adapter.mjs';
import { runSeparateReviewer } from '../../runtime/lib/reviewer-session.mjs';
import { runGates } from '../../runtime/lib/gates.mjs';

const GATE0 = 'Gate 0 passed: 412 tests, 0 failures on head h1';

const withDir = (fn) => async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt302-harness-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

// Fake binary: appends its argv to a log file, or writes a marker file when `marker` is given.
async function fakeBinary(dir, name) {
  const log = join(dir, `${name}.log`);
  const bin = join(dir, name);
  await writeFile(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
`);
  await chmod(bin, 0o755);
  return { bin, log };
}
const readArgv = async (log) => (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l).argv);

test('each harness declares name, capabilities and an invocation builder', () => {
  assert.deepEqual(selectHarness('pi').capabilities, { subSession: false, writeFiles: true, invocation: 'bash-wrapped' });
  assert.deepEqual(selectHarness('codex').capabilities, { subSession: false, writeFiles: true, invocation: 'exec' });
  assert.deepEqual(selectHarness('host-agent').capabilities, { subSession: true, writeFiles: true, invocation: 'in-process' });
  for (const name of ['pi', 'codex', 'host-agent']) {
    assert.equal(selectHarness(name).name, name);
    assert.equal(typeof selectHarness(name).buildArgs, 'function');
  }
  assert.deepEqual(Object.keys(HARNESSES).sort(), ['codex', 'host-agent', 'pi']);
});

test('unknown and prototype harness names fail closed, naming the harness', () => {
  assert.throws(() => selectHarness('deepseek'), /unknown harness: deepseek/);
  assert.throws(() => selectHarness('toString'), /unknown harness: toString/);
});

test('pi invocation keeps the bash-wrapped pi -p args; a separate process is a different session', () => {
  assert.deepEqual(selectHarness('pi').buildArgs({ sessionId: 's1', prompt: 'hi' }), ['--session-id', 's1', '-p', 'hi']);
});

test('codex invocation is exec, and exec resume when resuming', () => {
  const codex = selectHarness('codex');
  assert.deepEqual(codex.buildArgs({ sessionId: 's1', prompt: 'hi' }), ['exec', 'hi']);
  assert.deepEqual(codex.buildArgs({ sessionId: 's1', resume: true, prompt: 'hi' }), ['exec', 'resume', 's1', 'hi']);
});

test('pi and codex run through the existing launcher with fake binaries', withDir(async (dir) => {
  for (const name of ['pi', 'codex']) {
    const fake = await fakeBinary(dir, name);
    const launch = createAdapterLauncher({ adapter: selectHarness(name), command: fake.bin, spawnFn: spawn });
    assert.equal(await launch({ workspace: dir, sessionId: 's1', resume: false, prompt: 'P' }), 0);
    const [argv] = await readArgv(fake.log);
    assert.deepEqual(argv, name === 'pi' ? ['--session-id', 's1', '-p', 'P'] : ['exec', 'P']);
  }
}));

test('a fixture adapter with the same shape runs through the launcher without changing role code', withDir(async (dir) => {
  const fixture = {
    name: 'fixture',
    capabilities: { subSession: false, writeFiles: false, invocation: 'bash-wrapped' },
    buildArgs: ({ sessionId, prompt }) => ['--fixture', sessionId, prompt],
  };
  const fake = await fakeBinary(dir, 'fixture');
  const launch = createAdapterLauncher({ adapter: fixture, command: fake.bin, spawnFn: spawn });
  assert.equal(await launch({ workspace: dir, sessionId: 's9', prompt: 'Q' }), 0);
  assert.deepEqual((await readArgv(fake.log))[0], ['--fixture', 's9', 'Q']);
}));

test('host-agent builds no process command and is refused by the process launcher', withDir(async (dir) => {
  const host = selectHarness('host-agent');
  assert.equal(host.buildArgs({ sessionId: 's1', prompt: 'P' }), null);
  const marker = join(dir, 'spawned');
  const fake = join(dir, 'host-agent');
  await writeFile(fake, `#!/bin/sh\ntouch "${marker}"\n`);
  await chmod(fake, 0o755);
  assert.throws(() => createAdapterLauncher({ adapter: host, command: fake, spawnFn: spawn }), /in-process/);
  await assert.rejects(readFile(marker));
}));

test('degraded path: a missing reviewer binary falls back to a single-session review marked not independent', withDir(async (dir) => {
  const env = { ...process.env, RT_REVIEWER_COMMAND: join(dir, 'no-such-reviewer') };
  const result = await runSeparateReviewer({
    head: 'h1', gate0Summary: GATE0, env,
    review: async () => '审查结论：通过',
  });
  assert.deepEqual({ status: result.status, independent: result.independent }, { status: 'pass', independent: false });
}));

test('a degraded single-session pass is never a Gate 1 pass', withDir(async (dir) => {
  const env = { ...process.env, RT_REVIEWER_COMMAND: join(dir, 'no-such-reviewer') };
  const records = new Map();
  const gated = await runGates({
    issue: '302', head: 'h1', tree: 't1', changedFiles: [], models: { reviewer: 'pi' },
    state: { async get(id) { return records.get(id); }, async put(id, value) { records.set(id, structuredClone(value)); } },
    gates: {
      async gate0() { return { passed: true }; },
      reviewer: ({ head }) => runSeparateReviewer({ head, gate0Summary: GATE0, env, review: async () => '审查结论：通过' }),
    },
    ci: { async requiredGreen() { return { green: true }; } },
    merge: { async squash() { throw new Error('must not merge'); } },
    github: { async getPullRequest() { return { body: 'Closes #302' }; }, async recordedEscalationApproval() { return null; }, async addLabel() {} },
  });
  assert.equal(gated.status, 'blocked');
  assert.equal(gated.gate, 'gate1');
  assert.ok(!records.get('302')?.passed.includes('gate1'));
}));
