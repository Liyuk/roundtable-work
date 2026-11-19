import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostProvider, submit } from '../../host/outbox-bridge.mjs';
import { applyMergeReply, mergeItem, mergedNotice, requestRollback, rollbackItem } from '../../runtime/lib/merge-outbox.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';

const BRIDGE = fileURLToPath(new URL('../../host/outbox-bridge.mjs', import.meta.url));
const RT_MERGE = fileURLToPath(new URL('../../host/bin/rt-merge', import.meta.url));
const SHA = 'abc1234';

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'merge-outbox-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// Fake gh writer for the in-process tests: records writes, keeps comments in memory (no network).
const fakeGh = (root) => {
  const calls = [];
  const comments = [];
  return {
    calls, comments,
    squashMerge(pr, head, issue) { calls.push(['squash', pr, head, issue, openOutbox(root).pending().map((i) => i.id)]); },
    revertMerge(mergeSha) { calls.push(['revert', mergeSha]); },
    listComments: async (issue) => comments.filter((c) => c.issue === issue),
    createComment(issue, body) { calls.push(['comment', issue]); comments.push({ issue, body }); },
  };
};

// Enqueues and delivers one item through the bridge's submit; asserts that it has a receipt.
const deliver = async (root, writer, item) => {
  assert.equal(await submit({ root, writer, item }), true);
};

test('the squash is enqueued before the provider call: the merge item is pending when gh would merge', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh(root);
    await deliver(root, writer, mergeItem({ issue: 286, pr: 7, head: SHA }));
    assert.deepEqual(writer.calls, [['squash', 7, SHA, 286, ['merge:7:abc1234']]]);
  });
});

test('a delivered merge yields one done-pending-confirmation notice; a replayed merge adds no second notice or squash', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh(root);
    const cause = { issue: 286, pr: 7, head: SHA };
    await deliver(root, writer, mergeItem(cause));
    await deliver(root, writer, mergedNotice(cause));
    assert.equal(writer.comments.length, 1);
    assert.match(writer.comments[0].body, /PR #7 merged/);
    assert.equal(openOutbox(root).items().filter((i) => i.payload.subtype === 'done-pending-confirmation').length, 1);
    assert.equal(openOutbox(root).items().find((i) => i.kind === 'notification').id, `notice:merge:7:${SHA}`);
    await deliver(root, writer, mergeItem(cause));
    await deliver(root, writer, mergedNotice(cause));
    assert.equal(writer.calls.filter((c) => c[0] === 'squash').length, 1);
    assert.equal(writer.comments.length, 1);
    assert.equal(openOutbox(root).items().length, 2);
  });
});

test('a rollback is enqueued once with a stable id; a second request for the same cause is refused', async () => {
  await withRoot(async (root) => {
    const cause = { issue: 286, pr: 7, head: SHA, mergeSha: 'f00ba11' };
    assert.deepEqual(requestRollback(root, cause), { ok: true });
    assert.deepEqual(requestRollback(root, cause), { ok: false, reason: 'already-requested' });
    const rollbacks = openOutbox(root).items().filter((i) => i.id === `rollback:merge:7:${SHA}`);
    assert.equal(rollbacks.length, 1);
    const writer = fakeGh(root);
    await deliver(root, writer, rollbackItem(cause));
    assert.deepEqual(writer.calls, [['revert', 'f00ba11']]);
  });
});

test('the rollback item reaches gh only through the provider, with the merge sha', () => {
  const writer = { revertMerge: (sha) => { writer.sha = sha; } };
  assert.deepEqual(hostProvider(writer).deliver(rollbackItem({ issue: 286, pr: 7, head: SHA, mergeSha: 'f00ba11' })), { ok: true });
  assert.equal(writer.sha, 'f00ba11');
});

// Owner replies: the outbox snapshot (items and receipts) must be unchanged after every ignored reply.
test('unknown, wrong-state, non-owner and malformed replies change nothing', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh(root);
    const cause = { issue: 286, pr: 7, head: SHA };
    await deliver(root, writer, mergeItem(cause));
    const snapshot = () => JSON.stringify([openOutbox(root).items(), [...openOutbox(root).receipts()]]);
    const before = snapshot();
    const reply = (body, author = 'owner') => applyMergeReply({ root, owner: 'owner', event: { payload: { body, author } } });
    const outcomes = [
      await reply('/rt confirm merge:7:abc1234'), // merge delivered, notice not yet delivered: no receipt
      await reply('/rt confirm merge:9:abc1234'), // unknown PR
      await reply('/rt confirm merge:7:abc1234', 'someone-else'),
      await reply('/rt confirm merge:7'),
      await reply('/rt rollback merge:7:abc1234 extra'),
      await reply('/rt merge merge:7:abc1234'),
      await reply('hello'),
    ];
    for (const o of outcomes) assert.equal(o.outcome, 'ignored');
    assert.equal(snapshot(), before);
  });
});

test('a confirm reply from the owner for a delivered notice enqueues one confirmation', async () => {
  await withRoot(async (root) => {
    const writer = fakeGh(root);
    const cause = { issue: 286, pr: 7, head: SHA };
    await deliver(root, writer, mergeItem(cause));
    await deliver(root, writer, mergedNotice(cause));
    const reply = (body) => applyMergeReply({ root, owner: 'owner', event: { payload: { body, author: 'owner' } } });
    assert.equal((await reply(`/rt confirm merge:7:${SHA}`)).outcome, 'applied');
    assert.equal((await reply(`/rt confirm merge:7:${SHA}`)).outcome, 'ignored');
    assert.equal(openOutbox(root).items().filter((i) => i.id === `confirm:merge:7:${SHA}`).length, 1);
  });
});

test('the rt-merge script calls the outbox bridge and has no direct gh pr merge call', () => {
  const src = readFileSync(RT_MERGE, 'utf8');
  assert.doesNotMatch(src, /"pr", "merge"/);
  assert.match(src, /outbox-bridge\.mjs/);
});

test('the CLI merge op enqueues before gh runs, sends the notice once, and exits 0 only when delivered', async () => {
  await withRoot(async (root) => {
    const log = join(root, 'gh.log');
    const gh = join(root, 'gh');
    const outboxFile = join(root, '.roundtable', 'state', 'outbox.jsonl');
    writeFileSync(gh, `#!/bin/sh\nif [ "$1 $2" = "issue view" ]; then echo '{"comments":[]}'; exit 0; fi\nif [ "$1 $2" = "pr merge" ]; then grep -c '"id":"merge:7:${SHA}"' '${outboxFile}' >> '${log}'; fi\necho "$@" >> '${log}'\ncat >> '${log}.body' 2>/dev/null\n`);
    chmodSync(gh, 0o755);
    mkdirSync(join(root, '.roundtable', 'state'), { recursive: true });
    const run = (args) => spawnSync(process.execPath, [BRIDGE, root, 'owner/repo', ...args], { env: { ...process.env, RT_GH_REAL: gh }, encoding: 'utf8' });
    assert.equal(run(['merge', '286', '7', SHA]).status, 0);
    assert.equal(run(['merge', '286', '7', SHA]).status, 0);
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines[0], '1');
    assert.equal(lines[1], `pr merge 7 -R owner/repo --squash --match-head-commit ${SHA} --body Closes #286`);
    assert.equal(lines.filter((l) => l.startsWith('pr merge')).length, 1);
    assert.equal(lines.filter((l) => l.startsWith('issue comment')).length, 1);
  });
});
