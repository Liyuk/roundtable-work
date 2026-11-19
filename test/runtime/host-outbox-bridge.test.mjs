import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commentItem, hostProvider, labelItem, submit } from '../../host/outbox-bridge.mjs';
import { dispatch, openOutbox } from '../../runtime/lib/outbox.mjs';

const BRIDGE = fileURLToPath(new URL('../../host/outbox-bridge.mjs', import.meta.url));

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'host-outbox-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// Fake gh writer: records every write call and keeps issue labels and comments in memory (no network).
const fakeGh = () => {
  const calls = [];
  const labels = new Set();
  const comments = [];
  return {
    calls, labels, comments,
    addLabel(issue, label) { calls.push(['add', issue, label]); labels.add(`${issue}:${label}`); },
    removeLabel(issue, label) { calls.push(['rm', issue, label]); labels.delete(`${issue}:${label}`); },
    listComments: async (issue) => comments.filter((c) => c.issue === issue),
    createComment(issue, body) { calls.push(['comment', issue]); comments.push({ issue, body }); },
  };
};

test('a comment is enqueued, then posted once with the outbox marker and the host marker kept', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh();
    const item = commentItem(286, '<!-- rt:blocked -->\nBlocked: test\n');
    assert.equal(await submit({ root, writer, item }), true);
    assert.equal(writer.comments.length, 1);
    assert.match(writer.comments[0].body, /^<!-- rt:outbox comment:286:[0-9a-f]{16} -->\n<!-- rt:blocked -->\nBlocked: test\n$/);
    assert.deepEqual(openOutbox(root).pending(), []);
  });
});

test('a label add is enqueued, then applied to the issue', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh();
    assert.equal(await submit({ root, writer, item: labelItem(286, 'add', 'rt:running') }), true);
    assert.deepEqual(writer.calls, [['add', 286, 'rt:running']]);
    assert.ok(writer.labels.has('286:rt:running'));
  });
});

test('a notification is enqueued, then delivered as an issue comment', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh();
    const item = { id: 'alert:stall:286', kind: 'notification', issue: 286, payload: { subtype: 'stall-alert', of: 'the worker' } };
    assert.equal(await submit({ root, writer, item }), true);
    assert.equal(writer.comments.length, 1);
    assert.match(writer.comments[0].body, /Stall alert for the worker$/);
  });
});

test('a lost acknowledgement retried with the same item id posts the comment once', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh();
    const item = commentItem(286, '<!-- rt:ask -->\nQuestion\n');
    const outbox = openOutbox(root);
    outbox.enqueue(item);
    await hostProvider(writer).deliver({ ...item }); // provider applied the side effect; markDelivered is never recorded
    assert.equal(await submit({ root, writer, item }), true); // retry: same id, enqueue is refused, dispatch retries it
    assert.equal(writer.comments.length, 1);
    assert.deepEqual(openOutbox(root).pending(), []);
  });
});

test('a notification replayed with the same cause-derived id enqueues and posts once', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh();
    const item = { id: 'alert:stall:286', kind: 'notification', issue: 286, payload: { subtype: 'stall-alert', of: 'the worker' } };
    assert.equal(await submit({ root, writer, item }), true);
    assert.equal(await submit({ root, writer, item: { ...item } }), true);
    assert.equal(openOutbox(root).items().length, 1);
    assert.equal(writer.comments.length, 1);
  });
});

test('identical comment bodies on the same issue are posted once: a replayed comment is refused (accepted trade-off)', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh();
    assert.equal(await submit({ root, writer, item: commentItem(286, '<!-- rt:claim -->\nResume\n') }), true);
    assert.equal(await submit({ root, writer, item: commentItem(286, '<!-- rt:claim -->\nResume\n') }), true);
    assert.equal(writer.comments.length, 1);
  });
});

test('an add, remove, add label cycle applies all three writes', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh();
    for (const item of [labelItem(286, 'add', 'rt:hold'), labelItem(286, 'rm', 'rt:hold'), labelItem(286, 'add', 'rt:hold')]) {
      assert.equal(await submit({ root, writer, item }), true);
    }
    assert.deepEqual(writer.calls, [['add', 286, 'rt:hold'], ['rm', 286, 'rt:hold'], ['add', 286, 'rt:hold']]);
    assert.ok(writer.labels.has('286:rt:hold'));
  });
});

test('a failed write is dead-lettered and never retried, so a later write does not apply it out of order', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh();
    const addLabel = writer.addLabel;
    writer.addLabel = () => { throw new Error('gh down'); };
    assert.equal(await submit({ root, writer, item: labelItem(286, 'add', 'rt:running') }), false);
    assert.equal(openOutbox(root).failures(openOutbox(root).items()[0].id).length, 1);
    assert.deepEqual(openOutbox(root).pending(), []);
    writer.addLabel = addLabel;
    assert.equal(await submit({ root, writer, item: commentItem(286, 'next\n') }), true);
    assert.deepEqual(writer.calls.map((c) => c[0]), ['comment']);
  });
});

test('the CLI runs the real gh with argument arrays: label add/rm and comment body from stdin', async () => {
  await withRoot(async (root) => {
    const log = join(root, 'gh.log');
    const gh = join(root, 'gh');
    writeFileSync(gh, `#!/bin/sh\nif [ "$1 $2" = "issue view" ]; then echo '{"comments":[]}'; exit 0; fi\necho "$@" >> '${log}'\ncat >> '${log}.body' 2>/dev/null\n`);
    chmodSync(gh, 0o755);
    const run = (args, input) => spawnSync(process.execPath, [BRIDGE, root, 'owner/repo', ...args], { input, env: { ...process.env, RT_GH_REAL: gh }, encoding: 'utf8' });
    assert.equal(run(['label', '286', 'rm', 'rt:running']).status, 0);
    assert.equal(run(['comment', '286', '-'], 'hello\n').status, 0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.deepEqual(lines, ['issue edit 286 -R owner/repo --remove-label rt:running', 'issue comment 286 -R owner/repo --body-file -']);
    assert.match(readFileSync(`${log}.body`, 'utf8'), /^<!-- rt:outbox comment:286:[0-9a-f]{16} -->\nhello\n$/);
  });
});
