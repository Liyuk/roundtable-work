import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openOutbox, dispatch } from '../../runtime/lib/outbox.mjs';
import { createWebhookProvider, createSlackProvider, createTelegramProvider, createImRouter, loadRoutes, SENT_PATH } from '../../runtime/lib/outbox-im.mjs';

const env = { RT_HOOK_URL: 'https://hooks.example.test/in', RT_SLACK_URL: 'https://slack.example.test/in', RT_TG_TOKEN: '123:FAKE-TOKEN', RT_TG_CHAT: '-4242' };

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-im-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const notice = (over = {}) => ({ id: 'notice:merge:12:abc123', kind: 'notification', issue: 12, payload: { subtype: 'merge-notice', pr: 12, head: 'abc123' }, ...over });

// Fake transport: records each call and answers with the given status. No network is touched.
const fakeSend = (status = 200) => {
  const calls = [];
  const send = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), method: init.method });
    return { ok: status >= 200 && status < 300, status };
  };
  return { send, calls };
};

test('loadRoutes returns a list of channels for every subtype and throws TypeError for unknown names', () => {
  const channels = { hook: {}, slack: {} };
  const routes = loadRoutes({ channels, routes: { 'merge-notice': ['hook', 'slack'], digest: ['slack'] } });
  assert.deepEqual(routes['merge-notice'], ['hook', 'slack']);
  assert.deepEqual(routes['digest'], ['slack']);
  assert.deepEqual(routes['stall-alert'], []);
  assert.throws(() => loadRoutes({ channels, routes: { 'raw-log': ['hook'] } }), TypeError);
  assert.throws(() => loadRoutes({ channels, routes: { digest: ['nowhere'] } }), TypeError);
});

test('every provider requires an injected send function', () => {
  const root = tmpdir();
  assert.throws(() => createWebhookProvider({ root, name: 'hook', urlEnv: 'RT_HOOK_URL', env }), TypeError);
  assert.throws(() => createSlackProvider({ root, name: 'slack', urlEnv: 'RT_SLACK_URL', env, send: 'no' }), TypeError);
  assert.throws(() => createTelegramProvider({ root, name: 'tg', tokenEnv: 'RT_TG_TOKEN', chatEnv: 'RT_TG_CHAT', env }), TypeError);
});

test('webhook posts generic JSON with the fixed text and reads the URL from env', async () => {
  await withRoot(async (root) => {
    const { send, calls } = fakeSend();
    const provider = createWebhookProvider({ root, name: 'hook', urlEnv: 'RT_HOOK_URL', env, send });
    const receipt = await provider.deliver(notice());
    assert.deepEqual(receipt, { ok: true, status: 200 });
    assert.equal(calls[0].url, env.RT_HOOK_URL);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.text, 'PR #12 merged at abc123');
  });
});

test('slack posts {text} to its incoming webhook', async () => {
  await withRoot(async (root) => {
    const { send, calls } = fakeSend();
    const provider = createSlackProvider({ root, name: 'slack', urlEnv: 'RT_SLACK_URL', env, send });
    await provider.deliver(notice());
    assert.equal(calls[0].url, env.RT_SLACK_URL);
    assert.deepEqual(calls[0].body, { text: 'PR #12 merged at abc123' });
  });
});

test('telegram posts chat_id and text to the bot sendMessage endpoint', async () => {
  await withRoot(async (root) => {
    const { send, calls } = fakeSend();
    const provider = createTelegramProvider({ root, name: 'tg', tokenEnv: 'RT_TG_TOKEN', chatEnv: 'RT_TG_CHAT', env, send });
    await provider.deliver(notice());
    assert.equal(calls[0].url, 'https://api.telegram.org/bot123:FAKE-TOKEN/sendMessage');
    assert.deepEqual(calls[0].body, { chat_id: '-4242', text: 'PR #12 merged at abc123' });
    assert.ok(!JSON.stringify(calls[0].body).includes('FAKE-TOKEN'));
  });
});

test('a second deliver of the same item does not call send and returns the stored receipt', async () => {
  await withRoot(async (root) => {
    const { send, calls } = fakeSend();
    const provider = createSlackProvider({ root, name: 'slack', urlEnv: 'RT_SLACK_URL', env, send });
    const first = await provider.deliver(notice());
    const second = await provider.deliver(notice());
    assert.equal(calls.length, 1);
    assert.deepEqual(second, first);
    const lines = readFileSync(join(root, SENT_PATH), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ id: 'notice:merge:12:abc123', channel: 'slack', receipt: first }]);
  });
});

test('text comes only from the fixed template and selected fields', async () => {
  await withRoot(async (root) => {
    const { send, calls } = fakeSend();
    const provider = createWebhookProvider({ root, name: 'hook', urlEnv: 'RT_HOOK_URL', env, send });
    const raw = notice({ payload: { subtype: 'merge-notice', pr: 12, head: 'abc123', token: 'ghp_FAKE', path: '/srv/private/secret/repo', log: 'line one\nline two /srv/private/log' } });
    await provider.deliver(raw);
    assert.equal(calls[0].body.text, 'PR #12 merged at abc123');
    const stall = notice({ id: 'alert:dead:1', payload: { subtype: 'stall-alert', of: 'notice:merge:12:abc123', log: 'x\ny' } });
    await provider.deliver(stall);
    assert.equal(calls[1].body.text, 'Stall alert for notice:merge:12:abc123');
  });
});

test('token-like strings, absolute paths and raw logs never reach the sent body', async () => {
  await withRoot(async (root) => {
    const { send, calls } = fakeSend();
    const provider = createSlackProvider({ root, name: 'slack', urlEnv: 'RT_SLACK_URL', env, send });
    const secret = notice({ id: 'action:1', payload: { subtype: 'action-pending-confirmation', action: 'deploy', token: 'ghp_FAKE_TOKEN_123', path: '/srv/private/keys/id', log: 'first line\nsecond line /srv/private/x' } });
    await provider.deliver(secret);
    const sent = JSON.stringify(calls[0].body);
    assert.ok(!sent.includes('ghp_FAKE_TOKEN_123'));
    assert.ok(!sent.includes('/srv/private'));
    assert.ok(!sent.includes('first line'));
    assert.ok(!sent.includes('\n'));
  });
});

test('a non-2xx response throws without the URL or token, and dispatch records a failure then delivers on the next run', async () => {
  await withRoot(async (root) => {
    const outbox = openOutbox(root);
    outbox.enqueue(notice());
    let status = 500;
    const calls = [];
    const flaky = async (url) => { calls.push(url); return { ok: status < 300, status }; };
    const provider = createTelegramProvider({ root, name: 'tg', tokenEnv: 'RT_TG_TOKEN', chatEnv: 'RT_TG_CHAT', env, send: flaky });
    await assert.rejects(provider.deliver(notice()), (error) => {
      assert.match(error.message, /HTTP 500/);
      assert.ok(!error.message.includes('FAKE-TOKEN') && !error.message.includes('api.telegram'));
      return true;
    });
    const first = await dispatch({ outbox, provider, maxAttempts: 1 });
    assert.deepEqual(first, { delivered: [], failed: [notice().id] });
    assert.equal(outbox.failures(notice().id).length, 1);
    status = 200;
    const second = await dispatch({ outbox, provider });
    assert.deepEqual(second, { delivered: [notice().id], failed: [] });
    assert.equal(calls.length, 3);
  });
});

test('the router fans a notification out to every channel routed for its subtype', async () => {
  await withRoot(async (root) => {
    const hook = fakeSend();
    const slack = fakeSend();
    const routes = loadRoutes({ channels: { hook: {}, slack: {} }, routes: { 'merge-notice': ['hook', 'slack'] } });
    const providers = {
      hook: createWebhookProvider({ root, name: 'hook', urlEnv: 'RT_HOOK_URL', env, send: hook.send }),
      slack: createSlackProvider({ root, name: 'slack', urlEnv: 'RT_SLACK_URL', env, send: slack.send }),
    };
    const router = createImRouter({ routes, providers });
    const receipt = await router.deliver(notice());
    assert.deepEqual(receipt, { ok: true, channels: ['hook', 'slack'] });
    assert.equal(hook.calls.length, 1);
    assert.equal(slack.calls.length, 1);
    await router.deliver(notice());
    assert.equal(hook.calls.length, 1);
    assert.equal(slack.calls.length, 1);
  });
});
