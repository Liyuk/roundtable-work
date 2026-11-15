import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler, start } from '../../runtime/lib/webhook-listener.mjs';
import { INBOX_PATH, openInbox } from '../../runtime/lib/event-inbox.mjs';

const SECRET = 'test-secret';
const SOURCES = { github: { secret: SECRET, eventTypes: ['issues'] } };
const BODY = Buffer.from(JSON.stringify({ action: 'opened' }));
const sign = (body, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'webhook-listener-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Binds a plain node:http server to an ephemeral loopback port, returns the server and its base URL.
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const close = (server) => new Promise((resolve) => server.close(resolve));

const post = (base, source, body, headers = {}) => fetch(`${base}/webhook/${source}`, {
  method: 'POST',
  body,
  headers: { 'x-hub-signature-256': sign(body), 'x-github-event': 'issues', 'x-github-delivery': 'delivery-1', ...headers },
});

test('bad signature is rejected with 401 and nothing is appended', async () => {
  await withRoot(async (root) => {
    const handler = createHandler({ sources: SOURCES, inbox: openInbox(root) });
    const { server, base } = await listen(handler);
    try {
      const res = await post(base, 'github', BODY, { 'x-hub-signature-256': sign(BODY, 'wrong') });
      assert.equal(res.status, 401);
      assert.equal(handler.counts.bad_signature, 1);
      assert.equal(existsSync(join(root, INBOX_PATH)), false);
    } finally {
      await close(server);
    }
  });
});

test('unknown source and unlisted event type are ignored with 202 and nothing is appended', async () => {
  await withRoot(async (root) => {
    const handler = createHandler({ sources: SOURCES, inbox: openInbox(root) });
    const { server, base } = await listen(handler);
    try {
      const unknown = await post(base, 'gitlab', BODY);
      assert.equal(unknown.status, 202);
      assert.deepEqual(await unknown.json(), { status: 'ignored', reason: 'unknown_source' });
      const type = await post(base, 'github', BODY, { 'x-github-event': 'push' });
      assert.equal(type.status, 202);
      assert.deepEqual(await type.json(), { status: 'ignored', reason: 'event_type' });
      assert.equal(handler.counts.unknown_source, 1);
      assert.equal(handler.counts.event_type, 1);
      assert.equal(existsSync(join(root, INBOX_PATH)), false);
    } finally {
      await close(server);
    }
  });
});

test('valid delivery is appended once; a repeated delivery id is a duplicate', async () => {
  await withRoot(async (root) => {
    const handler = createHandler({ sources: SOURCES, inbox: openInbox(root) });
    const { server, base } = await listen(handler);
    try {
      const first = await post(base, 'github', BODY);
      assert.equal(first.status, 202);
      assert.deepEqual(await first.json(), { status: 'accepted' });
      const again = await post(base, 'github', BODY);
      assert.equal(again.status, 202);
      assert.deepEqual(await again.json(), { status: 'duplicate' });
      assert.equal(handler.counts.accepted, 1);
      assert.equal(handler.counts.duplicate, 1);
      const events = openInbox(root).events();
      assert.equal(events.length, 1);
      assert.equal(events[0].source_event_id, 'delivery-1');
      assert.equal(events[0].kind, 'webhook');
      assert.equal(events[0].payload.event_type, 'issues');
      assert.equal(events[0].payload.body, BODY.toString('utf8'));
    } finally {
      await close(server);
    }
  });
});

test('missing delivery id is a 400 and nothing is appended', async () => {
  await withRoot(async (root) => {
    const handler = createHandler({ sources: SOURCES, inbox: openInbox(root) });
    const { server, base } = await listen(handler);
    try {
      const res = await post(base, 'github', BODY, { 'x-github-delivery': '' });
      assert.equal(res.status, 400);
      assert.equal(handler.counts.bad_request, 1);
      assert.equal(existsSync(join(root, INBOX_PATH)), false);
    } finally {
      await close(server);
    }
  });
});

test('body larger than maxBytes is a 413 and nothing is appended', async () => {
  await withRoot(async (root) => {
    const handler = createHandler({ sources: SOURCES, inbox: openInbox(root), maxBytes: 16 });
    const { server, base } = await listen(handler);
    try {
      const res = await post(base, 'github', BODY);
      assert.equal(res.status, 413);
      assert.equal(handler.counts.too_large, 1);
      assert.equal(existsSync(join(root, INBOX_PATH)), false);
    } finally {
      await close(server);
    }
  });
});

test('other methods and paths are 404 and nothing is appended', async () => {
  await withRoot(async (root) => {
    const { server, base } = await listen(createHandler({ sources: SOURCES, inbox: openInbox(root) }));
    try {
      assert.equal((await fetch(`${base}/webhook/github`)).status, 404);
      assert.equal((await fetch(`${base}/other`, { method: 'POST', body: BODY })).status, 404);
      assert.equal(existsSync(join(root, INBOX_PATH)), false);
    } finally {
      await close(server);
    }
  });
});

test('start binds to loopback and appends to the root inbox when none is given', async () => {
  await withRoot(async (root) => {
    const server = await start({ port: 0, root, sources: SOURCES });
    try {
      assert.equal(server.address().address, '127.0.0.1');
      const res = await post(`http://127.0.0.1:${server.address().port}`, 'github', BODY);
      assert.equal(res.status, 202);
      assert.deepEqual(openInbox(root).events().map((e) => e.source_event_id), ['delivery-1']);
    } finally {
      await close(server);
    }
  });
});
