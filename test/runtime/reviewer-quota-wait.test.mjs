import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { classify } from '../../runtime/lib/classify.mjs';
import { runQueue } from './observation-fixture.mjs';

const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-quota-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const PASS = '审查结论：通过\nok';
async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'rt-quota-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('reviewer outages without a verdict refund the wake and count only the reviewer budget', () => withRoot(async root => {
  const failures = [{ exitCode: 1, output: 'boom' }, { timedOut: true }, { exitCode: 0, output: '   ' }, { exitCode: 0, output: 'no verdict' }];
  const handler = async ({ phase }) => phase === 'reviewing' ? failures.shift() : { exitCode: 0, output: 'ok' };
  const store = await createStateStore({ workRoot: root });
  for (let i = 0; i < 4; i++) {
    const r = await runQueue({ workRoot: root, queue: ['5'], handler, maxWakesPerIssue: 2, maxReviewerUnavailable: 99 });
    assert.equal(r.outcomes[0].class, 'reviewer_unavailable');
    assert.equal(r.outcomes[0].status, 'waiting_external');
    const state = await store.load('5');
    assert.equal(state.attempts.wakes, 0);
    assert.equal(state.attempts.developer, 0);
    assert.equal(state.attempts.reviewerUnavailable, i + 1);
  }
}));

test('reviewer outages still stop at the reviewer budget', () => withRoot(async root => {
  const handler = async ({ phase }) => phase === 'reviewing' ? { exitCode: 1 } : { exitCode: 0, output: 'ok' };
  const opts = { workRoot: root, queue: ['6'], handler, maxWakesPerIssue: 9, maxReviewerUnavailable: 2 };
  assert.equal((await runQueue(opts)).outcomes[0].status, 'waiting_external');
  const second = await runQueue(opts);
  assert.equal(second.outcomes[0].status, 'stop');
  assert.equal(second.outcomes[0].reason, 'reviewer_unavailable_budget_exhausted');
}));

test('an outage wake is refunded, so only the passing wake counts', () => withRoot(async root => {
  let fail = true;
  const handler = async ({ phase }) => phase === 'reviewing' && fail ? { exitCode: 1 } : phase === 'reviewing' ? { exitCode: 0, output: PASS } : { exitCode: 0, output: 'ok' };
  await runQueue({ workRoot: root, queue: ['7'], handler });
  fail = false;
  assert.equal((await runQueue({ workRoot: root, queue: ['7'], handler })).outcomes[0].status, 'done');
  assert.equal((await (await createStateStore({ workRoot: root })).load('7')).attempts.wakes, 1);
}));

test('a nonzero exit caused by HTTP 402 or a quota limit is a quota wait, not a developer failure', () => {
  for (const stage of ['developer', 'test', 'reviewer']) {
    for (const extra of [{ status: 402 }, { statusCode: 402 }, { reason: 'budget_exhausted' }]) {
      const r = classify({ stage, exitCode: 1, output: 'payment required', ...extra });
      assert.deepEqual([r.class, r.decision, r.consumesDeveloperRetry], ['quota_wait', 'wait', false], `${stage} ${JSON.stringify(extra)}`);
    }
  }
  assert.equal(classify({ stage: 'developer', exitCode: 1, status: 500 }).class, 'developer_failure');
  assert.equal(classify({ stage: 'developer', exitCode: 1 }).class, 'developer_failure');
});

test('a quota wait is waiting_external with decision wait and spends no developer or wake-retry budget', () => withRoot(async root => {
  const handler = async ({ phase }) => phase === 'developing' ? { exitCode: 1, statusCode: 402 } : { exitCode: 0, output: 'ok' };
  const r = await runQueue({ workRoot: root, queue: ['8'], handler });
  assert.deepEqual([r.outcomes[0].status, r.outcomes[0].class, r.outcomes[0].decision], ['waiting_external', 'quota_wait', 'wait']);
  const state = await (await createStateStore({ workRoot: root })).load('8');
  assert.equal(state.attempts.developer, 0);
  assert.notEqual(state.status, 'stop');
}));

test('a finalizing 402 is not a quota wait: finalizing keeps its no-automatic-rerun rule', () => {
  assert.equal(classify({ stage: 'finalize', exitCode: 1, statusCode: 402 }).class, 'finalize_failure');
});

