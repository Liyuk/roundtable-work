import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openClaims, processPending, coalesce, markApplied } from '../../runtime/lib/event-claim.mjs';

const CLAIM_MODULE = new URL('../../runtime/lib/event-claim.mjs', import.meta.url).href;

const event = (over = {}) => ({
  source_event_id: 'evt-1', kind: 'ci', issue: 266, payload: {}, receivedAt: 1000, ...over,
});

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'claim-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// Side effect: append the event id to an effects log, one line per application.
const effectsOf = (root) => (existsSync(join(root, 'effects.log'))
  ? readFileSync(join(root, 'effects.log'), 'utf8').split('\n').filter(Boolean)
  : []);
const applyEffects = (root) => (batch) => {
  for (const e of batch.events) appendFileSync(join(root, 'effects.log'), e.source_event_id + '\n');
};
// Idempotent effect keyed by source_event_id: a replayed dispatch does not append the id a second time.
const applyOnce = (root) => (batch) => {
  for (const e of batch.events) {
    if (!effectsOf(root).includes(e.source_event_id)) appendFileSync(join(root, 'effects.log'), e.source_event_id + '\n');
  }
};

// Runs `body` in a child process that is then killed (exits) at the point it reaches; it cannot ack.
const runChild = (root, body) => execFileSync(process.execPath, ['--input-type=module', '-e', `
  const { openClaims, markApplied, processPending } = await import(${JSON.stringify(CLAIM_MODULE)});
  const { appendFileSync, existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = ${JSON.stringify(root)};
  ${body}
  process.exit(0);`]);

test('an event whose side effect was applied before a crash (no ack written) is not applied again', async () => {
  await withRoot(async (root) => {
    openInbox(root).accept(event({ source_event_id: 'a' }));
    openInbox(root).accept(event({ source_event_id: 'b', kind: 'heartbeat', issue: null }));
    // Child worker: claims "a", applies the side effect, records the applied marker, then dies before the ack.
    runChild(root, `
      if (openClaims(root).claim('a') !== 'claimed') process.exit(3);
      appendFileSync(join(root, 'effects.log'), 'a\\n');
      markApplied(root, 'a');`);
    await processPending(root, applyEffects(root));
    assert.deepEqual(effectsOf(root), ['a', 'b']);
  });
});

test('a crash after the side effect but before the applied marker does not apply the effect again', async () => {
  await withRoot(async (root) => {
    openInbox(root).accept(event({ source_event_id: 'a' }));
    // Idempotent effect keyed by source_event_id: the child applies it, then dies before markApplied.
    runChild(root, `await processPending(root, (batch) => {
      const id = batch.events[0].source_event_id;
      const log = join(root, 'effects.log');
      if (!existsSync(log) || !readFileSync(log, 'utf8').includes(id + '\\n')) appendFileSync(log, id + '\\n');
      process.exit(0);
    });`);
    await processPending(root, applyOnce(root));
    assert.deepEqual(effectsOf(root), ['a']);
  });
});

test('a crash during dispatch, before the effect, replays the event after reload (not lost)', async () => {
  await withRoot(async (root) => {
    openInbox(root).accept(event({ source_event_id: 'a' }));
    runChild(root, `await processPending(root, () => process.exit(0));`);
    await processPending(root, applyEffects(root));
    assert.deepEqual(effectsOf(root), ['a']);
  });
});

test('an event claimed but interrupted before its side effect is replayed after reload, exactly once', async () => {
  await withRoot(async (root) => {
    openInbox(root).accept(event({ source_event_id: 'a' }));
    runChild(root, `if (openClaims(root).claim('a') !== 'claimed') process.exit(3);`);
    await processPending(root, applyEffects(root));
    assert.deepEqual(effectsOf(root), ['a']);
    await processPending(root, () => assert.fail('an acked event must not be dispatched again'));
    assert.deepEqual(effectsOf(root), ['a']);
  });
});

test('same kind and issue coalesce into one dispatch; different kind or issue stay separate', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    inbox.accept(event({ source_event_id: 'a1', issue: 7 }));
    inbox.accept(event({ source_event_id: 'a2', issue: 7 }));
    inbox.accept(event({ source_event_id: 'a3', issue: 7 }));
    inbox.accept(event({ source_event_id: 'b1', issue: 8 }));
    inbox.accept(event({ source_event_id: 'c1', kind: 'owner_comment', issue: 7 }));
    const batches = [];
    await processPending(root, (batch) => batches.push({
      kind: batch.kind, issue: batch.issue, ids: batch.events.map((e) => e.source_event_id),
    }));
    assert.deepEqual(batches, [
      { kind: 'ci', issue: 7, ids: ['a1', 'a2', 'a3', 'c1'] },
      { kind: 'ci', issue: 8, ids: ['b1'] },
    ]);
  });
});

test('coalesce groups events by kind and issue in first-seen order', () => {
  const groups = coalesce([
    event({ source_event_id: 'x', issue: 1 }),
    event({ source_event_id: 'y', issue: 1 }),
    event({ source_event_id: 'z', issue: 2 }),
  ]);
  assert.deepEqual(groups.map((g) => g.events.map((e) => e.source_event_id)), [['x', 'y'], ['z']]);
});

test('two concurrent claimants on the same key: exactly one claimed, the other already_claimed', async () => {
  await withRoot(async (root) => {
    const claims = openClaims(root);
    const results = await Promise.all([claims.claim('batch-1'), claims.claim('batch-1')]);
    assert.deepEqual(results.sort(), ['already_claimed', 'claimed']);
  });
});

test('a claim is still held after the winner acked, so processed events are not re-claimed', async () => {
  await withRoot(async (root) => {
    openInbox(root).accept(event({ source_event_id: 'a' }));
    await processPending(root, () => {});
    assert.equal(openClaims(root).claim('a'), 'already_claimed');
  });
});
