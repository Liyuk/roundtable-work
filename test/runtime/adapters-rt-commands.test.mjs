import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, childEnv, createAdapterLauncher, selectAdapter } from '../../runtime/lib/agent-adapter.mjs';
import { parseRtCommand, RT_COMMANDS } from '../../runtime/lib/rt-commands.mjs';
import { startFrontChief, statusOf } from '../../runtime/lib/front-chief.mjs';

// Lock records live in a private anchor for the whole file; every work root is its own temporary directory.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-adapter-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
after(() => rm(ANCHOR, { recursive: true, force: true }));

const ROLE = '# Chief role\nYou are the front Chief.';
const withWs = (fn) => async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-adapter-ws-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

// Fake provider: appends its argv and the names of its env keys to a log file, then exits 0.
async function fakeProvider(dir, name) {
  const log = join(dir, `${name}.log`);
  const bin = join(dir, name);
  await writeFile(bin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env) }) + '\\n');
`);
  await chmod(bin, 0o755);
  return { bin, log };
}
const readLog = async (log) => (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));

for (const name of ['pi', 'codex']) {
  test(`AC1 ${name}: start then resume through the front Chief with fake provider keeps one session`, withWs(async (dir) => {
    const fake = await fakeProvider(dir, name);
    const launch = createAdapterLauncher({ adapter: ADAPTERS[name], command: fake.bin, spawnFn: spawn });
    const first = await startFrontChief({ workspace: dir, rolePrompt: ROLE, anchorRoot: ANCHOR, launch });
    const before = await statusOf(dir);
    const second = await startFrontChief({ workspace: dir, rolePrompt: ROLE, anchorRoot: ANCHOR, launch });
    assert.equal(first.started, true);
    assert.equal(second.started, true);
    assert.equal(first.resume, false);
    assert.equal(second.resume, true);
    assert.equal(second.sessionId, first.sessionId);
    assert.deepEqual(await statusOf(dir), before);
    const runs = await readLog(fake.log);
    assert.equal(runs.length, 2);
    assert.ok(runs[0].argv.at(-1).startsWith(ROLE), 'prompt is the last argv element');
    assert.ok(runs[1].argv.includes(first.sessionId), 'resume passes the same session id');
  }));
}

test('AC2: /rt accepts pause, resume, requeue and status only', () => {
  assert.deepEqual(RT_COMMANDS, ['pause', 'resume', 'requeue', 'status']);
  for (const word of ['pause', 'resume', 'requeue', 'status']) {
    assert.deepEqual(parseRtCommand(`/rt ${word}`), { ok: true, command: word });
    assert.deepEqual(parseRtCommand(`  /rt ${word}  \n`), { ok: true, command: word });
  }
  for (const text of ['/rt merge', '/rt', '/rt pause now', '/RT pause', 'pause', '/rt approve', '', 42, null]) {
    const r = parseRtCommand(text);
    assert.equal(r.ok, false, `rejected: ${JSON.stringify(text)}`);
    assert.equal(typeof r.reason, 'string');
  }
  assert.match(parseRtCommand('/rt merge').reason, /merge is not accepted from \/rt/);
});

test('AC3: the child environment has no GitHub token keys', withWs(async (dir) => {
  const fake = await fakeProvider(dir, 'pi');
  const env = { PATH: process.env.PATH, GH_TOKEN: 'test-token', GITHUB_TOKEN: 'test-token', GH_ENTERPRISE_TOKEN: 'test-token' };
  const launch = createAdapterLauncher({ adapter: ADAPTERS.pi, command: fake.bin, env, spawnFn: spawn });
  await launch({ workspace: dir, sessionId: 's1', resume: false, prompt: 'p' });
  const [run] = await readLog(fake.log);
  assert.ok(run.envKeys.includes('PATH'));
  assert.deepEqual(run.envKeys.filter((k) => /^(GH|GITHUB)_/.test(k)), []);
}));

test('childEnv keeps non-GitHub keys and drops every GH_/GITHUB_ key', () => {
  const env = { PATH: '/bin', HOME: '/h', GH_TOKEN: 'test-token', GITHUB_TOKEN: 'test-token', GH_HOST: 'x', GITHUB_API_URL: 'y' };
  assert.deepEqual(childEnv(env), { PATH: '/bin', HOME: '/h' });
  assert.equal(env.GH_TOKEN, 'test-token', 'the input env is not mutated');
});

test('selectAdapter: known names return the adapter, unknown names throw naming it', () => {
  assert.equal(selectAdapter('pi'), ADAPTERS.pi);
  assert.equal(selectAdapter('codex'), ADAPTERS.codex);
  assert.throws(() => selectAdapter('claude'), (e) => e instanceof Error && /claude/.test(e.message));
  assert.ok(Object.isFrozen(ADAPTERS));
});

test('launcher rejects when the command cannot be spawned', async () => {
  const launch = createAdapterLauncher({ adapter: ADAPTERS.pi, command: '/nonexistent/rt-no-such-binary', spawnFn: spawn });
  await assert.rejects(launch({ workspace: tmpdir(), sessionId: 's', resume: false, prompt: 'p' }), /ENOENT/);
});
