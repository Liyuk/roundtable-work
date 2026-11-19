import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fixMain, reviewMain } from '../../scripts/rt-entry.mjs';

const exec = promisify(execFile);
const SHA = '0123456789abcdef0123456789abcdef01234567';
const TASK = 'Fix the off-by-one in the pager';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCRIPTS = new URL('../../scripts/', import.meta.url);
const ROUTING = fileURLToPath(new URL('./routing-fixture.json', import.meta.url));

// Fake agent binary: appends one JSON line to RT_FAKE_LOG and exits 0.
const fake = (name) => `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.RT_FAKE_LOG, JSON.stringify({ cmd: '${name}', argv: process.argv.slice(2), cwd: process.cwd(), gh: process.env.GH_TOKEN ?? '', pid: process.pid }) + '\\n');
process.exit(0);
`;

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-entry-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  await mkdir(bin);
  for (const name of ['pi', 'codex']) {
    await writeFile(join(bin, name), fake(name));
    await chmod(join(bin, name), 0o755);
  }
  const workspace = join(dir, 'ws');
  await mkdir(workspace);
  const log = join(dir, 'calls.jsonl');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, RT_FAKE_LOG: log, GH_TOKEN: 'fake-token' };
  const config = async (roles, implementerRole = 'developer') => {
    const file = join(dir, 'harness.json');
    const allPi = { chief: 'pi', developer: 'pi', fixer: 'pi', reviewer: 'pi', researcher: 'pi', verifier: 'pi', security: 'pi' };
    await writeFile(file, JSON.stringify({ roles: { ...allPi, ...roles }, implementerRole }));
    return file;
  };
  return { dir, workspace, log, env, config };
}

const readCalls = async (log) => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));

function sinks() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    stdout: { write: (s) => { out.stdout += s; return true; } },
    stderr: { write: (s) => { out.stderr += s; return true; } },
  };
}

const deps = (s, env, extra = {}) => ({ env, stdout: s.stdout, stderr: s.stderr, git: async () => SHA, ...extra });

test('rt-fix: reads the default config, invokes pi once in the workspace without GH_TOKEN', async (t) => {
  const { workspace, log, env } = await setup(t);
  const s = sinks();
  const code = await fixMain(['--workspace', workspace, '--task', TASK, '--routing', ROUTING], deps(s, env));
  assert.equal(code, 0, s.out.stderr);
  const calls = await readCalls(log);
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.cmd, 'pi');
  assert.equal(call.argv[0], '--session-id');
  assert.match(call.argv[1], UUID);
  assert.equal(call.argv[2], '-p');
  assert.match(call.argv[3], /^Bug fix without an issue number\. /);
  assert.ok(call.argv[3].includes(TASK));
  assert.equal(call.cwd, await realpath(workspace));
  assert.equal(call.gh, '');
});

test('rt-fix: the run prompt carries the routing block with the developer model from the routing file', async (t) => {
  const { workspace, log, env } = await setup(t);
  const s = sinks();
  const fixture = JSON.parse(await readFile(ROUTING, 'utf8'));
  const { harness, model } = fixture.windows[0].roles.developer;
  const now = Date.parse('2026-06-01T00:00:00Z');
  assert.equal(await fixMain(['--workspace', workspace, '--task', TASK, '--routing', ROUTING], deps(s, env, { now })), 0, s.out.stderr);
  const [call] = await readCalls(log);
  assert.ok(call.argv[3].includes('## Routing for this run'));
  assert.ok(call.argv[3].includes(`- developer: harness=${harness} model=${model} tier=`));
});

test('rt-fix: missing --routing exits 1 and spawns nothing', async (t) => {
  const { workspace, log, env } = await setup(t);
  const s = sinks();
  assert.equal(await fixMain(['--workspace', workspace, '--task', TASK], deps(s, env)), 1);
  assert.match(s.out.stderr, /--routing/);
  assert.deepEqual(await readCalls(log), []);
});

test('rt-fix: invalid routing file exits 1 and spawns nothing', async (t) => {
  const { dir, workspace, log, env } = await setup(t);
  const bad = join(dir, 'routing.json');
  await writeFile(bad, '{}');
  const s = sinks();
  assert.equal(await fixMain(['--workspace', workspace, '--task', TASK, '--routing', bad], deps(s, env)), 1);
  assert.match(s.out.stderr, /routing/);
  assert.deepEqual(await readCalls(log), []);
});

test('rt-review: reads the default config, invokes pi with the head sha, in a separate process and session from the fix', async (t) => {
  const { workspace, log, env } = await setup(t);
  const s = sinks();
  assert.equal(await fixMain(['--workspace', workspace, '--task', TASK, '--routing', ROUTING], deps(s, env)), 0);
  assert.equal(await reviewMain(['--workspace', workspace], deps(s, env)), 0, s.out.stderr);
  const [fix, review] = await readCalls(log);
  assert.equal(review.cmd, 'pi');
  assert.equal(review.argv[0], '--session-id');
  assert.match(review.argv[1], UUID);
  assert.notEqual(review.argv[1], fix.argv[1], 'reviewer must not reuse the implementer session');
  assert.equal(review.argv[2], '-p');
  assert.ok(review.argv[3].includes(`Review the change at head ${SHA}`));
  assert.ok(review.argv[3].includes('No Gate 0 summary was recorded; do not assume tests passed.'));
  assert.notEqual(review.pid, fix.pid, 'reviewer must run as its own OS process');
});

test('rt-review: --gate0 file contents are the Gate 0 summary in the prompt', async (t) => {
  const { dir, workspace, log, env } = await setup(t);
  const gate0 = join(dir, 'gate0.txt');
  await writeFile(gate0, 'npm test: exit 0, 42 passing');
  const s = sinks();
  assert.equal(await reviewMain(['--workspace', workspace, '--gate0', gate0], deps(s, env)), 0);
  const [call] = await readCalls(log);
  assert.ok(call.argv[3].includes('npm test: exit 0, 42 passing'));
});

test('config is read: reviewer role codex runs `codex exec <prompt>`, implementer role codex runs `codex exec`', async (t) => {
  const { workspace, log, env, config } = await setup(t);
  const s = sinks();
  const codexReviewer = await config({ reviewer: 'codex' });
  assert.equal(await reviewMain(['--workspace', workspace, '--config', codexReviewer], deps(s, env)), 0, s.out.stderr);
  const codexDev = await config({ developer: 'codex' });
  assert.equal(await fixMain(['--workspace', workspace, '--task', TASK, '--routing', ROUTING, '--config', codexDev], deps(s, env)), 0, s.out.stderr);
  const [review, fix] = await readCalls(log);
  assert.equal(review.cmd, 'codex');
  assert.equal(review.argv[0], 'exec');
  assert.ok(review.argv[1].includes(`Review the change at head ${SHA}`));
  assert.equal(review.argv.length, 2);
  assert.equal(fix.cmd, 'codex');
  assert.equal(fix.argv[0], 'exec');
  assert.ok(fix.argv[1].includes(TASK));
});

test('fail closed: unknown reviewer harness exits 1 and spawns nothing', async (t) => {
  const { workspace, log, env, config } = await setup(t);
  const s = sinks();
  const code = await reviewMain(['--workspace', workspace, '--config', await config({ reviewer: 'bogus' })], deps(s, env));
  assert.equal(code, 1);
  assert.match(s.out.stderr, /unknown harness: bogus/);
  assert.deepEqual(await readCalls(log), []);
});

test('fail closed: implementer role harness "toString" (prototype name) exits 1 and spawns nothing', async (t) => {
  const { workspace, log, env, config } = await setup(t);
  const s = sinks();
  const code = await fixMain(['--workspace', workspace, '--task', TASK, '--routing', ROUTING, '--config', await config({ developer: 'toString' })], deps(s, env));
  assert.equal(code, 1);
  assert.match(s.out.stderr, /unknown harness: toString/);
  assert.deepEqual(await readCalls(log), []);
});

test('missing --workspace or --task exits 1 and spawns nothing', async (t) => {
  const { workspace, log, env } = await setup(t);
  const s = sinks();
  assert.equal(await fixMain(['--task', TASK], deps(s, env)), 1);
  assert.equal(await reviewMain([], deps(s, env)), 1);
  assert.equal(await fixMain(['--workspace', workspace], deps(s, env)), 1);
  assert.match(s.out.stderr, /usage/);
  assert.deepEqual(await readCalls(log), []);
});

test('script wrappers: rt-fix.mjs and rt-review.mjs run the entry points and exit with their code', async (t) => {
  const { workspace, log, env } = await setup(t);
  await exec('git', ['init', '-q'], { cwd: workspace });
  await exec('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: workspace });
  await exec(process.execPath, [fileURLToPath(new URL('rt-fix.mjs', SCRIPTS)), '--workspace', workspace, '--task', TASK, '--routing', ROUTING], { env });
  await exec(process.execPath, [fileURLToPath(new URL('rt-review.mjs', SCRIPTS)), '--workspace', workspace], { env });
  const calls = await readCalls(log);
  assert.deepEqual(calls.map((c) => c.cmd), ['pi', 'pi']);
  assert.ok(calls[1].argv[3].includes('Review the change at head'));
});
