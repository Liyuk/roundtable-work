import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNotifyFileProvider, readAck, writeAck } from '../runtime/lib/outbox-notify.mjs';

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'outbox-notify-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const FILE = '.roundtable/state/outbox/notify.jsonl';
const ACK = '.roundtable/state/outbox/notify.ack';
const fixedNow = () => '2026-01-02T03:04:05.000Z';
const lines = (root) => readFileSync(join(root, FILE), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const merge = (over = {}) => ({
  id: 'notice:merge:12:abc123',
  kind: 'notification',
  issue: 12,
  payload: { subtype: 'merge-notice', pr: 12, head: 'abc123' },
  ...over,
});

test('a notification appends one JSON line with the fixed fields, nulls for unknown ones', async () => {
  await withRoot(async (root) => {
    const provider = createNotifyFileProvider({ root, now: fixedNow });
    await provider.deliver(merge());
    assert.equal(lines(root).length, 1);
    assert.deepEqual(lines(root)[0], {
      id: 'notice:merge:12:abc123',
      ts: '2026-01-02T03:04:05.000Z',
      event: 'merge-notice',
      issue: 12,
      pr: 12,
      commit: 'abc123',
      recipient: null,
      summary: 'merge notice for PR #12 on issue #12',
    });
  });
});

test('a summary never carries raw payload fields beyond the named ones', async () => {
  await withRoot(async (root) => {
    const provider = createNotifyFileProvider({ root, now: fixedNow });
    await provider.deliver({ id: 'digest:1', kind: 'notification', issue: null, payload: { subtype: 'digest', state: 'secret-token /private/path' } });
    const [line] = lines(root);
    assert.equal(line.event, 'digest');
    assert.equal(line.issue, null);
    assert.equal(line.pr, null);
    assert.equal(line.commit, null);
    assert.equal(line.summary, 'digest');
    assert.ok(!readFileSync(join(root, FILE), 'utf8').includes('secret-token'));
  });
});

test('a repeated item id appends no second line and returns the stored receipt', async () => {
  await withRoot(async (root) => {
    const provider = createNotifyFileProvider({ root, now: fixedNow });
    const first = await provider.deliver(merge());
    const again = await provider.deliver(merge());
    assert.equal(lines(root).length, 1);
    assert.deepEqual(again, first);
  });
});

test('the ack cursor is written, read back after a restart, and does not re-emit consumed lines', async () => {
  await withRoot(async (root) => {
    const provider = createNotifyFileProvider({ root, now: fixedNow });
    await provider.deliver(merge());
    assert.equal(readAck(root), null);
    writeAck(root, 'notice:merge:12:abc123');
    assert.equal(readFileSync(join(root, ACK), 'utf8').trim(), 'notice:merge:12:abc123');

    const restarted = createNotifyFileProvider({ root, now: fixedNow });
    assert.equal(readAck(root), 'notice:merge:12:abc123');
    await restarted.deliver(merge());
    assert.equal(lines(root).length, 1);
    await restarted.deliver(merge({ id: 'digest:2', payload: { subtype: 'digest', state: 'ok' }, issue: null }));
    assert.deepEqual(lines(root).map((l) => l.id), ['notice:merge:12:abc123', 'digest:2']);
    assert.equal(readAck(root), 'notice:merge:12:abc123');
  });
});
