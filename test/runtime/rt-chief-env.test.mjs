import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../bin/rt-chief.mjs';

// The front Chief lock lives in a private anchor for this file; every workspace is its own temporary directory.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-chief-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
const dirs = [ANCHOR];
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const MODULE_URL = new URL('../../runtime/lib/gh-write-proxy.mjs', import.meta.url).href;
const REPO = 'acme/widgets';
const GH_KEYS = (keys) => keys.filter((k) => /^(GH|GITHUB)_/.test(k));

async function scratch(name) {
  const dir = await mkdtemp(join(tmpdir(), `rt-chief-${name}-`));
  dirs.push(dir);
  return dir;
}

async function fakeChild(dir, body) {
  const bin = join(dir, 'fake-agent.mjs');
  await writeFile(bin, `#!${process.execPath}\n${body}`);
  await chmod(bin, 0o755);
  return bin;
}

function roleFile(dir) {
  return writeFile(join(dir, 'role.md'), '# Chief role\nYou are the front Chief.').then(() => join(dir, 'role.md'));
}

const quiet = () => ({ write: () => true });

test('start: the real launch path gives the child no GH_ or GITHUB_ keys', async () => {
  const dir = await scratch('env');
  const ws = join(dir, 'ws');
  await mkdir(ws);
  const log = join(dir, 'keys.json');
  const bin = await fakeChild(dir, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(log)}, JSON.stringify(Object.keys(process.env)));\n`);
  const env = { PATH: process.env.PATH, RT_AGENT_BIN: bin, RT_GH_REPO: REPO, GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret' };
  const code = await main(['start', '--workspace', ws, '--role-prompt', await roleFile(dir)], { env, stdout: quiet(), stderr: quiet(), execute: async () => '' });
  assert.equal(code, 0);
  const keys = JSON.parse(await readFile(log, 'utf8'));
  assert.deepEqual(GH_KEYS(keys), []);
  assert.ok(keys.includes('RT_GH_PROXY_SOCKET'));
});

test('start: the real entry serves the write proxy on RT_GH_PROXY_SOCKET and runs an allowed write once', async () => {
  const dir = await scratch('proxy');
  const ws = join(dir, 'ws');
  await mkdir(ws);
  const log = join(dir, 'child.json');
  const bin = await fakeChild(dir, `import { writeFileSync } from 'node:fs';
const { requestWrite } = await import(${JSON.stringify(MODULE_URL)});
const response = await requestWrite({ socketPath: process.env.RT_GH_PROXY_SOCKET, request: { tool: 'gh', args: ['issue', 'comment', '1', '--body', 'x', '--repo', process.env.RT_GH_REPO] } });
writeFileSync(${JSON.stringify(log)}, JSON.stringify({ keys: Object.keys(process.env), response }));
`);
  const calls = [];
  const execute = async (call) => { calls.push(call); return 'ok'; };
  const env = { PATH: process.env.PATH, RT_AGENT_BIN: bin, RT_GH_REPO: REPO, GH_TOKEN: 'secret' };
  const code = await main(['start', '--workspace', ws, '--role-prompt', await roleFile(dir)], { env, stdout: quiet(), stderr: quiet(), execute });
  assert.equal(code, 0);
  const { keys, response } = JSON.parse(await readFile(log, 'utf8'));
  assert.equal(keys.includes('GH_TOKEN'), false);
  assert.deepEqual(GH_KEYS(keys), []);
  assert.deepEqual(response, { status: 'done', stdout: 'ok' });
  assert.deepEqual(calls, [{ tool: 'gh', args: ['issue', 'comment', '1', '--body', 'x', '--repo', REPO], cwd: ws }]);
});
