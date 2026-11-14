import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { routeCard, recordFailure, resumeFromApproval, startLine, readLine } from '../../runtime/lib/decision-cards.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';

const card = (over = {}) => ({
  issue: 262, category: 'naming', question: 'Which name?', options: ['a', 'b'], recommendation: 'a',
  evidence: ['docs/x.md'], ...over,
});
const ask = (over = {}) => card({ category: 'destructive', ...over });
const fakeProvider = (choice = 'a') => ({ decide: async () => ({ choice, reason: 'rule says so', source: 'rule' }) });
const tick = () => { let t = 0; return () => ++t; };

let root;
test.before(async () => { root = await mkdtemp(join(tmpdir(), 'decision-cards-')); });
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test('1. non-closed category is decided by the provider and resumes without an owner step', async () => {
  const issue = 1001;
  await startLine({ root, issue, sessionId: 's-1001' });
  let calls = 0;
  const provider = { decide: async ({ card: c }) => { calls += 1; assert.equal(c.category, 'naming'); return { choice: 'b', reason: 'fewer words', source: 'model' }; } };
  const r = await routeCard({ root, card: card({ issue }), provider, now: tick() });
  assert.deepEqual(r, { status: 'resumed', choice: 'b' });
  assert.equal(calls, 1);
  const line = await readLine(root, issue);
  assert.equal(line.status, 'running');
  assert.equal(line.pending, null);
  assert.equal(line.decisions.length, 1);
  assert.equal(line.decisions[0].choice, 'b');
  assert.equal(line.decisions[0].source, 'model');
});

test('2. closed-list category pauses only its line; the other line keeps running', async () => {
  const a = 2001; const b = 2002;
  await startLine({ root, issue: a, sessionId: 's-a' });
  await startLine({ root, issue: b, sessionId: 's-b' });
  const provider = fakeProvider('a');
  const [ra, rb] = await Promise.all([
    routeCard({ root, card: ask({ issue: a }), provider, now: tick() }),
    routeCard({ root, card: card({ issue: b }), provider, now: tick() }),
  ]);
  assert.deepEqual(ra, { status: 'suspended' });
  assert.deepEqual(rb, { status: 'resumed', choice: 'a' });
  assert.equal((await readLine(root, a)).status, 'suspended');
  assert.equal((await readLine(root, b)).status, 'running');
});

test('3. repeated failure is detected, fixed internally, and does not stop the loop (chief and supervisor)', async () => {
  const issue = 3001; const sig = 'build:TypeError:x';
  const first = await recordFailure({ root, issue, signature: sig, source: 'chief', now: tick() });
  assert.deepEqual(first, { status: 'running', fixed: true });
  assert.equal((await readLine(root, issue)).fixes[sig].action, 'retry');
  const second = await recordFailure({ root, issue, signature: sig, source: 'chief', now: tick() });
  assert.deepEqual(second, { status: 'running', repeated: true, fixed: true });
  assert.equal((await readLine(root, issue)).failures[sig], 2);

  const sup = 3002; const sig2 = 'stall:no-output';
  const s1 = await recordFailure({ root, issue: sup, signature: sig2, source: 'supervisor', now: tick() });
  assert.deepEqual(s1, { status: 'running', fixed: true });
  assert.equal((await readLine(root, sup)).fixes[sig2].source, 'supervisor');
  const s2 = await recordFailure({ root, issue: sup, signature: sig2, source: 'supervisor', now: tick() });
  assert.deepEqual(s2, { status: 'running', repeated: true, fixed: true });
});

test('4. approval-required action suspends only its line: session saved, slot released, others run', async () => {
  const a = 4001; const b = 4002;
  await startLine({ root, issue: a, sessionId: 's-4001' });
  await startLine({ root, issue: b, sessionId: 's-4002' });
  const r = await routeCard({ root, card: ask({ issue: a }), provider: fakeProvider(), now: tick() });
  assert.deepEqual(r, { status: 'suspended' });
  const la = await readLine(root, a);
  assert.equal(la.slot, null);
  assert.equal(la.sessionId, 's-4001');
  assert.equal(la.pending.category, 'destructive');
  assert.equal((await routeCard({ root, card: card({ issue: b }), provider: fakeProvider(), now: tick() })).status, 'resumed');
  assert.equal((await readLine(root, b)).status, 'running');
});

test('5. owner approval arrives as an inbox event after restart; resumes from the saved session id; dedupes', async () => {
  const issue = 5001;
  await startLine({ root, issue, sessionId: 's-5001' });
  await routeCard({ root, card: ask({ issue }), provider: fakeProvider(), now: tick() });

  // simulate process restart: new objects over the same root
  const event = { source_event_id: 'comment-9', kind: 'owner_comment', issue, payload: { decision: 'approve' }, receivedAt: 1 };
  const r = await resumeFromApproval({ root, inbox: openInbox(root), event, now: tick() });
  assert.deepEqual(r, { status: 'resumed', sessionId: 's-5001' });
  const line = await readLine(root, issue);
  assert.equal(line.status, 'running');
  assert.equal(line.sessionId, 's-5001');
  assert.equal(line.pending, null);
  assert.equal(line.slot, 'worker');

  assert.equal(openInbox(root).accept(event), false, 'second accept returns false');
  const dup = await resumeFromApproval({ root, inbox: openInbox(root), event, now: tick() });
  assert.deepEqual(dup, { status: 'duplicate' });
});

test('5b. rejection resumes the line and records the rejection', async () => {
  const issue = 5002;
  await startLine({ root, issue, sessionId: 's-5002' });
  await routeCard({ root, card: ask({ issue }), provider: fakeProvider(), now: tick() });
  const event = { source_event_id: 'comment-10', kind: 'owner_comment', issue, payload: { decision: 'reject' }, receivedAt: 2 };
  const r = await resumeFromApproval({ root, inbox: openInbox(root), event, now: tick() });
  assert.deepEqual(r, { status: 'resumed', sessionId: 's-5002' });
  const line = await readLine(root, issue);
  assert.equal(line.status, 'running');
  assert.equal(line.decisions.at(-1).choice, 'reject');
});

test('6. no in-process wait for the owner: fake timers, slot free while suspended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const issue = 6001;
  await startLine({ root, issue, sessionId: 's-6001' });
  const r = await routeCard({ root, card: ask({ issue }), provider: fakeProvider(), now: tick() });
  assert.deepEqual(r, { status: 'suspended' });
  assert.equal((await readLine(root, issue)).slot, null);
  const other = await routeCard({ root, card: card({ issue: 6002 }), provider: fakeProvider(), now: tick() });
  assert.equal(other.status, 'resumed');
  const event = { source_event_id: 'comment-11', kind: 'owner_comment', issue, payload: { decision: 'approve' }, receivedAt: 3 };
  assert.deepEqual(await resumeFromApproval({ root, inbox: openInbox(root), event, now: tick() }), { status: 'resumed', sessionId: 's-6001' });
  assert.equal((await readLine(root, issue)).slot, 'worker');
});

test('provider failure or invalid choice fails closed: line suspends with reason', async () => {
  const issue = 7001;
  const thrower = { decide: async () => { throw new Error('boom'); } };
  assert.deepEqual(await routeCard({ root, card: card({ issue }), provider: thrower, now: tick() }), { status: 'suspended' });
  assert.match((await readLine(root, issue)).pending.reason, /boom/);
  const bad = { decide: async () => ({ choice: 'zzz', reason: 'x', source: 'model' }) };
  assert.deepEqual(await routeCard({ root, card: card({ issue: 7002 }), provider: bad, now: tick() }), { status: 'suspended' });
});

test('invalid card shape throws TypeError', async () => {
  await assert.rejects(routeCard({ root, card: card({ extra: 1 }), provider: fakeProvider(), now: tick() }), TypeError);
  await assert.rejects(routeCard({ root, card: card({ options: ['only'] }), provider: fakeProvider(), now: tick() }), TypeError);
  await assert.rejects(routeCard({ root, card: card({ recommendation: 'zzz' }), provider: fakeProvider(), now: tick() }), TypeError);
  await assert.rejects(routeCard({ root, card: card({ evidence: [] }), provider: fakeProvider(), now: tick() }), TypeError);
});
