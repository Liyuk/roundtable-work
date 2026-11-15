import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADAPTERS, childEnv, createAdapterLauncher } from '../../runtime/lib/agent-adapter.mjs';
import { classifyWrite, createWriteProxy, requestWrite, startWriteProxy } from '../../runtime/lib/gh-write-proxy.mjs';

const REPO = 'acme/widgets';
const MODULE_URL = new URL('../../runtime/lib/gh-write-proxy.mjs', import.meta.url).href;
const dirs = [];
const tempDir = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-gh-proxy-'));
  dirs.push(dir);
  return dir;
};
after(() => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

const gh = (args) => ({ tool: 'gh', args });
const git = (args) => ({ tool: 'git', args });
const countingExecutor = () => {
  const calls = [];
  const execute = async (call) => {
    calls.push(call);
    return `ran ${call.tool}`;
  };
  return { calls, execute };
};

test('classifyWrite allows issue comment/create, pr create/comment and plain branch pushes', () => {
  const allowed = [
    gh(['issue', 'comment', '1', '--body', 'hi']),
    gh(['issue', 'create', '--title', 't']),
    gh(['pr', 'create', '--title', 't', '--repo', REPO]),
    gh(['pr', 'comment', '2', '--body', 'x']),
    git(['push', 'origin', 'rt/285-pi']),
    git(['push', '-u', 'origin', 'HEAD:feature/x']),
  ];
  for (const request of allowed) assert.deepEqual(classifyWrite(request, { repo: REPO }), { allowed: true }, JSON.stringify(request));
});

test('classifyWrite requires an explicit destination branch for pushes', () => {
  const denied = [
    [git(['push', 'origin', 'HEAD']), 'not-allow-listed'],
    [git(['push', 'origin', 'HEAD:main']), 'push-main'],
    [git(['push', 'origin', 'HEAD:refs/heads/main']), 'push-main'],
    [git(['push', 'origin']), 'not-allow-listed'],
    [git(['push', 'origin', '@']), 'not-allow-listed'],
  ];
  for (const [request, kind] of denied) assert.equal(classifyWrite(request, { repo: REPO }).kind, kind, JSON.stringify(request));
  assert.deepEqual(classifyWrite(git(['push', 'origin', 'HEAD:rt/285-pi']), { repo: REPO }), { allowed: true });
  assert.deepEqual(classifyWrite(git(['push', 'origin', 'rt/285-pi']), { repo: REPO }), { allowed: true });
});

test('classifyWrite denies each kind with its reason', () => {
  const denied = [
    [gh(['pr', 'merge', '3']), 'merge'],
    [gh(['issue', 'close', '4']), 'close'],
    [gh(['pr', 'close', '5']), 'close'],
    [git(['push', 'origin', '+rt/x:rt/x']), 'force-push'],
    [git(['push', '--force', 'origin', 'rt/x']), 'force-push'],
    [git(['push', '-f', 'origin', 'rt/x']), 'force-push'],
    [git(['push', '--force-with-lease', 'origin', 'rt/x']), 'force-push'],
    [git(['push', 'origin', 'HEAD:main']), 'push-main'],
    [git(['push', 'origin', 'main']), 'push-main'],
    [git(['push', 'origin', 'refs/heads/master']), 'push-main'],
    [git(['push', 'origin', ':rt/x']), 'not-allow-listed'],
    [git(['push', '--delete', 'origin', 'rt/x']), 'not-allow-listed'],
    [gh(['api', 'repos/acme/widgets/pulls']), 'not-allow-listed'],
    [gh(['pr', 'comment', '1', '--repo', 'other/repo']), 'not-allow-listed'],
    [gh(['release', 'create', 'v1']), 'not-allow-listed'],
    [{ tool: 'curl', args: ['x'] }, 'malformed'],
    [{ tool: 'gh', args: 'pr merge' }, 'malformed'],
    [{ tool: 'gh', args: [] }, 'malformed'],
    [null, 'malformed'],
  ];
  for (const [request, kind] of denied) {
    const result = classifyWrite(request, { repo: REPO });
    assert.equal(result.allowed, false, JSON.stringify(request));
    assert.equal(result.kind, kind, JSON.stringify(request));
    assert.equal(typeof result.reason, 'string');
  }
});

test('handle denies merge without calling the executor', async () => {
  const { calls, execute } = countingExecutor();
  const proxy = createWriteProxy({ repo: REPO, execute });
  assert.equal((await proxy.handle(gh(['pr', 'merge', '3']))).status, 'denied');
  assert.equal(calls.length, 0);
});

test('handle denies close without calling the executor', async () => {
  const { calls, execute } = countingExecutor();
  const proxy = createWriteProxy({ repo: REPO, execute });
  assert.equal((await proxy.handle(gh(['issue', 'close', '4']))).status, 'denied');
  assert.equal((await proxy.handle(gh(['pr', 'close', '5']))).status, 'denied');
  assert.equal(calls.length, 0);
});

test('handle denies force-push without calling the executor', async () => {
  const { calls, execute } = countingExecutor();
  const proxy = createWriteProxy({ repo: REPO, execute });
  assert.equal((await proxy.handle(git(['push', '--force', 'origin', 'rt/x']))).status, 'denied');
  assert.equal((await proxy.handle(git(['push', 'origin', '+rt/x:rt/x']))).status, 'denied');
  assert.equal(calls.length, 0);
});

test('handle denies direct push to main without calling the executor', async () => {
  const { calls, execute } = countingExecutor();
  const proxy = createWriteProxy({ repo: REPO, execute });
  assert.equal((await proxy.handle(git(['push', 'origin', 'HEAD:main']))).status, 'denied');
  assert.equal((await proxy.handle(git(['push', 'origin', 'refs/heads/master']))).status, 'denied');
  assert.equal(calls.length, 0);
});

test('handle runs an allowed request exactly once and reports its stdout', async () => {
  const { calls, execute } = countingExecutor();
  const audited = [];
  const proxy = createWriteProxy({ repo: REPO, execute, audit: (entry) => audited.push(entry) });
  const result = await proxy.handle(gh(['issue', 'comment', '1', '--body', 'hi']));
  assert.deepEqual(result, { status: 'done', stdout: 'ran gh' });
  assert.deepEqual(calls, [{ tool: 'gh', args: ['issue', 'comment', '1', '--body', 'hi'] }]);
  assert.equal(audited.length, 1);
  assert.equal(audited[0].status, 'done');
});

test('handle reports executor failure as failed', async () => {
  const proxy = createWriteProxy({ repo: REPO, execute: async () => { throw new Error('boom'); } });
  const result = await proxy.handle(gh(['issue', 'create', '--title', 't']));
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /boom/);
});

test('socket: child gets no GH_ token, a write runs once on the host, and a denied write does not run', async (t) => {
  const dir = await tempDir();
  const socketPath = join(dir, 'proxy.sock');
  const { calls, execute } = countingExecutor();
  const server = await startWriteProxy({ socketPath, proxy: createWriteProxy({ repo: REPO, execute }) });
  t.after(() => server.close());

  const script = `
const { requestWrite } = await import(${JSON.stringify(MODULE_URL)});
const socketPath = process.env.RT_GH_PROXY_SOCKET;
const ok = await requestWrite({ socketPath, request: { tool: 'gh', args: ['issue', 'comment', '7', '--body', 'hi'] } });
const denied = await requestWrite({ socketPath, request: { tool: 'git', args: ['push', 'origin', 'HEAD:main'] } });
console.log(JSON.stringify({ keys: Object.keys(process.env), ok, denied }));
`;
  const env = { ...childEnv({ ...process.env, GH_TOKEN: 'test-token' }), RT_GH_PROXY_SOCKET: socketPath };
  const out = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}`))));
  });
  const { keys, ok, denied } = JSON.parse(out);
  assert.equal(keys.some((k) => /^(GH|GITHUB)_/.test(k)), false);
  assert.equal(ok.status, 'done');
  assert.equal(denied.status, 'denied');
  assert.equal(denied.kind, 'push-main');
  assert.deepEqual(calls, [{ tool: 'gh', args: ['issue', 'comment', '7', '--body', 'hi'] }]);
});

test('requestWrite replaces a stale socket file and the server closes cleanly', async (t) => {
  const dir = await tempDir();
  const socketPath = join(dir, 'stale.sock');
  const { execute } = countingExecutor();
  const first = await startWriteProxy({ socketPath, proxy: createWriteProxy({ repo: REPO, execute }) });
  await first.close();
  const second = await startWriteProxy({ socketPath, proxy: createWriteProxy({ repo: REPO, execute }) });
  t.after(() => second.close());
  const response = await requestWrite({ socketPath, request: gh(['pr', 'merge', '1']) });
  assert.equal(response.status, 'denied');
  assert.equal(response.kind, 'merge');
});

test('createAdapterLauncher passes RT_GH_PROXY_SOCKET and no GH_/GITHUB_ keys to the child', async () => {
  let seen;
  const spawnFn = (command, args, options) => {
    seen = options.env;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  const launch = createAdapterLauncher({
    adapter: ADAPTERS.pi,
    command: 'pi-bin',
    env: { PATH: '/usr/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret' },
    spawnFn,
    proxySocket: '/tmp/rt-proxy.sock',
  });
  assert.equal(await launch({ workspace: '.', sessionId: 's', resume: false, prompt: 'p' }), 0);
  assert.equal(seen.RT_GH_PROXY_SOCKET, '/tmp/rt-proxy.sock');
  assert.equal(seen.PATH, '/usr/bin');
  assert.equal(Object.keys(seen).some((k) => /^(GH|GITHUB)_/.test(k)), false);
});
