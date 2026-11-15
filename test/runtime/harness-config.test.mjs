import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadHarnessConfig, implementerLaunch, HARNESS_CONFIG } from '../../runtime/lib/harness.mjs';
import { ROLES } from '../../runtime/lib/routing.mjs';

// The front Chief lock lives in a private anchor for this file.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt303-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
after(() => rm(ANCHOR, { recursive: true, force: true }));

const withDir = (fn) => async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt303-harness-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

// Fake binary that appends its argv to a log file.
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

const configWith = (dir, developer) => {
  const roles = Object.fromEntries(ROLES.map((role) => [role, 'pi']));
  roles.developer = developer;
  const file = join(dir, 'harness.config.json');
  return writeFile(file, JSON.stringify({ roles, implementerRole: 'developer' })).then(() => file);
};

const facts = {
  window: 'w1',
  roles: Object.fromEntries(ROLES.map((role) => [role, { harness: 'pi', model: `vendor/${role}-model`, tier: 'standard' }])),
};

test('the in-repo config names a known harness for every role and routes the implementer to developer', async () => {
  const config = await loadHarnessConfig(HARNESS_CONFIG);
  assert.deepEqual(Object.keys(config.roles).sort(), [...ROLES].sort());
  assert.equal(config.implementerRole, 'developer');
});

test('an unknown harness name in the config fails closed, naming the harness', withDir(async (dir) => {
  const file = await configWith(dir, 'deepseek');
  await assert.rejects(loadHarnessConfig(file), /unknown harness: deepseek/);
}));

test('a missing harness name fails closed instead of defaulting to pi', withDir(async (dir) => {
  const file = await configWith(dir, undefined);
  await assert.rejects(loadHarnessConfig(file), /unknown harness: undefined/);
}));

test('switching the implementer harness from pi to codex changes the launched args, with no role-code change', withDir(async (dir) => {
  const env = { PATH: process.env.PATH };
  const fakePi = await fakeBinary(dir, 'pi');
  const fakeCodex = await fakeBinary(dir, 'codex');
  const piConfig = await loadHarnessConfig(await configWith(dir, 'pi'));
  const codexConfig = await loadHarnessConfig(await configWith(dir, 'codex'));

  const pi = implementerLaunch({ config: piConfig, facts, command: fakePi.bin, spawnFn: spawn, env });
  const codex = implementerLaunch({ config: codexConfig, facts, command: fakeCodex.bin, spawnFn: spawn, env });
  assert.equal(await pi.launch({ workspace: dir, sessionId: 's1', resume: false, prompt: 'P' }), 0);
  assert.equal(await codex.launch({ workspace: dir, sessionId: 's1', resume: false, prompt: 'P' }), 0);

  assert.deepEqual(JSON.parse((await readFile(fakePi.log, 'utf8')).trim()).argv, ['--session-id', 's1', '-p', 'P']);
  assert.deepEqual(JSON.parse((await readFile(fakeCodex.log, 'utf8')).trim()).argv, ['exec', 'P']);
}));

test('the implementer model is the developer entry of the routing table', withDir(async (dir) => {
  const config = await loadHarnessConfig(await configWith(dir, 'codex'));
  const { model } = implementerLaunch({ config, facts, command: 'unused', spawnFn: spawn });
  assert.equal(model, 'vendor/developer-model');
}));

test('an implementer configured with an in-process harness is refused by the process launcher', withDir(async (dir) => {
  const config = await loadHarnessConfig(await configWith(dir, 'host-agent'));
  assert.throws(() => implementerLaunch({ config, facts, command: 'unused', spawnFn: spawn }), /in-process/);
}));

test('chief start refuses an unknown harness in the config before spawning anything', withDir(async (dir) => {
  const { main } = await import('../../bin/rt-chief.mjs');
  const roles = Object.fromEntries(ROLES.map((role) => [role, 'pi']));
  roles.chief = 'deepseek';
  const harnessConfig = join(dir, 'harness.config.json');
  await writeFile(harnessConfig, JSON.stringify({ roles, implementerRole: 'developer' }));
  const err = [];
  const code = await main(['start', '--workspace', dir], {
    env: { RT_AGENT_BIN: join(dir, 'never-run') }, harnessConfig, stdout: { write() {} }, stderr: { write: (s) => err.push(s) },
  });
  assert.equal(code, 1);
  assert.match(err.join(''), /unknown harness: deepseek/);
}));

test('chief default launch takes its harness from roles.chief: switching pi to codex changes the launched argv', withDir(async (dir) => {
  const { main } = await import('../../bin/rt-chief.mjs');
  const bins = join(dir, 'bin');
  await mkdir(bins);
  const fakePi = await fakeBinary(bins, 'pi');
  const fakeCodex = await fakeBinary(bins, 'codex');
  const env = { PATH: `${bins}:${process.env.PATH}` };
  const runChief = async (chief) => {
    const ws = join(dir, chief); // a fresh workspace per run, so each start is a new session
    await mkdir(ws);
    const roles = Object.fromEntries(ROLES.map((role) => [role, 'pi']));
    roles.chief = chief;
    const harnessConfig = join(dir, `${chief}.config.json`);
    await writeFile(harnessConfig, JSON.stringify({ roles, implementerRole: 'developer' }));
    const code = await main(['start', '--workspace', ws], { env, harnessConfig, execute: async () => '', stdout: { write() {} }, stderr: { write() {} } });
    assert.equal(code, 0);
  };
  const argvOf = async (log) => JSON.parse((await readFile(log, 'utf8')).trim()).argv;

  await runChief('pi');
  const [flag, sessionId, p, prompt] = await argvOf(fakePi.log);
  assert.deepEqual([flag, p], ['--session-id', '-p']);
  assert.ok(sessionId && prompt);

  await runChief('codex');
  const [sub, codexPrompt, ...extra] = await argvOf(fakeCodex.log);
  assert.equal(sub, 'exec');
  assert.ok(codexPrompt);
  assert.deepEqual(extra, []);
}));
