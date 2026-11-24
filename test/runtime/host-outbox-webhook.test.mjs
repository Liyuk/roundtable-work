import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submit } from '../../host/outbox-bridge.mjs';
import { mergedNotice } from '../../runtime/lib/merge-outbox.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';

const KEY = 'host-key-643-xyz';
const URL_ = 'https://hook.example.test/in';
const cause = { issue: 286, pr: 7, head: 'abc123' };

const writer = () => ({
  squashMerge() {},
  addLabel() {},
  removeLabel() {},
  createComment() {},
  listComments: async () => [],
});

// Runs fn with a fresh outbox root and captures stderr writes.
async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'host-webhook-test-'));
  const errors = [];
  const saved = process.stderr.write;
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  try { return await fn(root, errors); } finally { process.stderr.write = saved; rmSync(root, { recursive: true, force: true }); }
}

test('a merge notice is POSTed through the webhook sink when RT_NOTIFY_WEBHOOK_URL is set, with no network', async () => {
  await withRoot(async (root) => {
    const posts = [];
    const send = async (url, init) => { posts.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
    const env = { RT_NOTIFY_WEBHOOK_URL: URL_, RT_NOTIFY_WEBHOOK_KEY: KEY, RT_NOTIFY_WEBHOOK_SCHEME: 'Bearer', RT_NOTIFY_WEBHOOK_HEADER: 'authorization' };
    assert.equal(await submit({ root, writer: writer(), item: mergedNotice(cause), send, env }), true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, URL_);
    assert.equal(posts[0].headers.authorization, `Bearer ${KEY}`);
    assert.equal(posts[0].body.event, 'done-pending-confirmation');
    assert.equal(posts[0].body.id, 'notice:merge:7:abc123');
  });
});

test('a merge notice posts nothing when RT_NOTIFY_WEBHOOK_URL is unset', async () => {
  await withRoot(async (root) => {
    const sent = [];
    const send = async (url) => { sent.push(url); return { ok: true, status: 200 }; };
    assert.equal(await submit({ root, writer: writer(), item: mergedNotice(cause), send, env: { RT_NOTIFY_WEBHOOK_KEY: KEY } }), true);
    assert.deepEqual(sent, []);
  });
});

test('a webhook failure after the GitHub write keeps the receipt, writes one secret-free stderr line, and does not dead-letter', async () => {
  await withRoot(async (root, errors) => {
    const send = async () => ({ ok: false, status: 500 });
    const env = { RT_NOTIFY_WEBHOOK_URL: URL_, RT_NOTIFY_WEBHOOK_KEY: KEY };
    const item = mergedNotice(cause);
    assert.equal(await submit({ root, writer: writer(), item, send, env }), true);
    assert.ok(openOutbox(root).receipts().has(item.id));
    assert.equal(errors.length, 1);
    assert.equal(errors[0], 'webhook notification not delivered: webhook delivery failed after 3 attempts: HTTP 500\n');
    assert.ok(!errors.join('').includes(KEY) && !errors.join('').includes(URL_));
  });
});
