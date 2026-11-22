import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createWebhookSink, withWebhook } from '../../runtime/lib/outbox-webhook.mjs';
import { fetchTransport } from '../../scripts/im-transport.mjs';

const KEY = 'test-key-629-abc';

// Local HTTP stub on 127.0.0.1: answers with statuses[i] for request i (the last status repeats).
async function stub(statuses) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(statuses[Math.min(requests.length, statuses.length) - 1]);
      res.end('response body that must not leak');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/hook`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Captures console output produced while fn runs, so the test can check that no secret was printed.
async function captureConsole(fn) {
  const out = [];
  const saved = { log: console.log, error: console.error };
  console.log = (...args) => out.push(args.join(' '));
  console.error = (...args) => out.push(args.join(' '));
  try { return { result: await fn(), out }; } finally { Object.assign(console, saved); }
}

const merge = (over = {}) => ({
  id: 'notice:merge:12:abc123',
  kind: 'notification',
  issue: 12,
  payload: { subtype: 'merge-notice', pr: 12, head: 'abc123' },
  ...over,
});

const noSleep = () => Promise.resolve();

test('a notification is POSTed once as the file-sink record, with the key in the configured header', async () => {
  const server = await stub([200]);
  try {
    const env = { RT_NOTIFY_WEBHOOK_URL: server.url, RT_NOTIFY_WEBHOOK_KEY: KEY, RT_NOTIFY_WEBHOOK_HEADER: 'x-custom-key' };
    const sink = createWebhookSink({ env, send: fetchTransport, sleep: noSleep });
    await sink.deliver(merge());
    assert.equal(server.requests.length, 1);
    const { ts, ...record } = server.requests[0].body;
    assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.deepEqual(record, {
      id: 'notice:merge:12:abc123',
      event: 'merge-notice',
      issue: 12,
      pr: 12,
      commit: 'abc123',
      recipient: null,
      summary: 'merge notice for PR #12 on issue #12',
    });
    assert.equal(server.requests[0].headers['x-custom-key'], KEY);
  } finally { await server.close(); }
});

test('the default key header is x-rt-notify-key', async () => {
  const server = await stub([200]);
  try {
    const sink = createWebhookSink({ env: { RT_NOTIFY_WEBHOOK_URL: server.url, RT_NOTIFY_WEBHOOK_KEY: KEY }, send: fetchTransport, sleep: noSleep });
    await sink.deliver(merge());
    assert.equal(server.requests[0].headers['x-rt-notify-key'], KEY);
  } finally { await server.close(); }
});

test('a 500 twice then 200 is retried with backoff, and every attempt carries the same item id', async () => {
  const server = await stub([500, 500, 200]);
  const sleeps = [];
  try {
    const env = { RT_NOTIFY_WEBHOOK_URL: server.url, RT_NOTIFY_WEBHOOK_KEY: KEY };
    const sink = createWebhookSink({ env, send: fetchTransport, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); }, backoffMs: 1000 });
    await sink.deliver(merge());
    assert.equal(server.requests.length, 3);
    assert.deepEqual(server.requests.map((r) => r.body.id), ['notice:merge:12:abc123', 'notice:merge:12:abc123', 'notice:merge:12:abc123']);
    assert.deepEqual(sleeps, [1000, 2000]);
  } finally { await server.close(); }
});

test('a stub that always fails throws after maxAttempts, and the message has no key, URL or response body', async () => {
  const server = await stub([500]);
  try {
    const env = { RT_NOTIFY_WEBHOOK_URL: server.url, RT_NOTIFY_WEBHOOK_KEY: KEY };
    const sink = createWebhookSink({ env, send: fetchTransport, sleep: noSleep, maxAttempts: 3 });
    const { result, out } = await captureConsole(() => sink.deliver(merge()).then(() => null, (err) => err));
    assert.equal(server.requests.length, 3);
    assert.ok(result instanceof Error);
    assert.match(result.message, /HTTP 500/);
    for (const secret of [KEY, server.url, String(new URL(server.url).port), 'response body']) assert.ok(!result.message.includes(secret));
    assert.ok(!out.some((line) => line.includes(KEY)));
  } finally { await server.close(); }
});

test('without RT_NOTIFY_WEBHOOK_URL the sink is null, nothing is sent, and withWebhook returns the provider unchanged', async () => {
  const server = await stub([200]);
  try {
    const provider = { deliver: async () => 'receipt' };
    const sink = createWebhookSink({ env: { RT_NOTIFY_WEBHOOK_KEY: KEY }, send: fetchTransport, sleep: noSleep });
    assert.equal(sink, null);
    assert.equal(withWebhook(provider, sink), provider);
    assert.equal(server.requests.length, 0);
  } finally { await server.close(); }
});

test('withWebhook delivers to the provider first and posts only notification items', async () => {
  const server = await stub([200]);
  try {
    const sink = createWebhookSink({ env: { RT_NOTIFY_WEBHOOK_URL: server.url, RT_NOTIFY_WEBHOOK_KEY: KEY }, send: fetchTransport, sleep: noSleep });
    const calls = [];
    const provider = { deliver: async (item) => { calls.push(item.id); return { id: item.id }; } };
    const wrapped = withWebhook(provider, sink);
    assert.deepEqual(await wrapped.deliver(merge()), { id: 'notice:merge:12:abc123' });
    await wrapped.deliver({ id: 'gh:1', kind: 'github', issue: 1, payload: {} });
    assert.deepEqual(calls, ['notice:merge:12:abc123', 'gh:1']);
    assert.deepEqual(server.requests.map((r) => r.body.id), ['notice:merge:12:abc123']);
  } finally { await server.close(); }
});

test('with RT_NOTIFY_WEBHOOK_SCHEME the key header carries "<scheme> <key>"', async () => {
  const sent = [];
  const send = async (url, init) => { sent.push({ url, headers: init.headers }); return { ok: true, status: 200 }; };
  const env = { RT_NOTIFY_WEBHOOK_URL: 'https://hook.example.test/in', RT_NOTIFY_WEBHOOK_KEY: KEY, RT_NOTIFY_WEBHOOK_SCHEME: 'Bearer', RT_NOTIFY_WEBHOOK_HEADER: 'authorization' };
  await createWebhookSink({ env, send, sleep: noSleep }).deliver(merge());
  assert.equal(sent[0].headers.authorization, `Bearer ${KEY}`);
  assert.ok(!('x-rt-notify-key' in sent[0].headers));
});
