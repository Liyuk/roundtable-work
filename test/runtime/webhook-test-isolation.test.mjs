import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { submit } from '../../host/outbox-bridge.mjs';
import { createWebhookSink } from '../../runtime/lib/outbox-webhook.mjs';
import { mergedNotice } from '../../runtime/lib/merge-outbox.mjs';

// Fake production endpoint on 127.0.0.1: counts every request it receives.
async function listener() {
  const requests = [];
  const server = createServer((req, res) => { requests.push(req.url); req.resume(); res.writeHead(200); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

const writer = { squashMerge() {}, addLabel() {}, removeLabel() {}, createComment() {}, listComments: async () => [] };
const stallAlert = { id: 'alert:stall:286', kind: 'notification', issue: 286, payload: { subtype: 'stall-alert', of: 'notice:merge:7:abc1234' } };

test('under test mode, the webhook sink posts nothing without an injected transport, for merge and stall notices', async () => {
  const hook = await listener();
  const root = mkdtempSync(join(tmpdir(), 'webhook-isolation-'));
  try {
    const env = { RT_NOTIFY_WEBHOOK_URL: hook.url, RT_NOTIFY_WEBHOOK_KEY: 'isolation-key' };
    assert.equal(await submit({ root, writer, item: mergedNotice({ issue: 286, pr: 7, head: 'abc1234', mergeSha: '9dd3481' }), env }), true);
    assert.equal(await submit({ root, writer, item: stallAlert, env }), true);
    assert.deepEqual(hook.requests, []);
    assert.equal(createWebhookSink({ env }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await hook.close();
  }
});
