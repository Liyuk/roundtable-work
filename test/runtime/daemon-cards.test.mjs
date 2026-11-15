import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDispatchLine, ownerOf } from '../../runtime/lib/daemon-cards.mjs';
import { produceEvents } from '../../runtime/lib/daemon-events.mjs';
import { cycleSteps } from '../../runtime/lib/daemon-loop.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { readLine, startLine } from '../../runtime/lib/decision-cards.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const OWNER = 'octo-owner';
const QUESTION = 'Delete the branch?';
const HASH = '8be0e98fa9de28cc'; // sha256('Delete the branch?') first 16 hex chars, precomputed

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-cards-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// A decision source for the cycle: issue 11 asks a closed-category question, issue 12 asks a naming question.
const decisionOf = (issue) => ({
  11: { category: 'destructive', question: QUESTION, evidence: ['docs/a.md'] },
  12: { category: 'naming', question: 'Which name?', evidence: ['docs/b.md'] },
}[issue]);

// A fake provider that chooses 'approve' for any non-closed card.
const approver = { decide: async () => ({ choice: 'approve', reason: 'fits the rule', source: 'rule' }) };

const ciEvent = (id, issue) => ({ source_event_id: id, kind: 'ci', issue, payload: {}, receivedAt: T0 });
const ownerEvent = (id, issue, payload) => ({ source_event_id: id, kind: 'owner_comment', issue, payload, receivedAt: T0 });

const cycle = (root, dispatchLine, { reader } = {}) => cycleSteps({
  root, inbox: openInbox(root), timers: openTimers(root), reader, now: T0, dispatchLine,
});

test('ownerOf takes the repo owner segment and is undefined without a repo', () => {
  assert.equal(ownerOf('octo-owner/roundtable-work'), 'octo-owner');
  assert.equal(ownerOf(undefined), undefined);
});

test('A2: a closed-category ask suspends only its line; another line in the same cycle still runs', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 11, sessionId: 's-11' });
    await startLine({ root, issue: 12, sessionId: 's-12' });
    const inbox = openInbox(root);
    inbox.accept(ciEvent('ci-11', 11));
    inbox.accept(ciEvent('ci-12', 12));
    await cycle(root, makeDispatchLine({ root, decisionOf, provider: approver }));
    const suspended = await readLine(root, 11);
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.pending.category, 'destructive');
    assert.deepEqual(suspended.pending.options, ['approve', 'reject']);
    assert.equal(suspended.pending.recommendation, 'reject');
    assert.deepEqual(suspended.pending.evidence, ['docs/a.md']);
    const other = await readLine(root, 12);
    assert.equal(other.status, 'running');
    assert.equal(other.decisions[0].choice, 'approve');
  });
});

test('A3: a suspended line enqueues one approval-request notification, and repeats add nothing', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 11, sessionId: 's-11' });
    openInbox(root).accept(ciEvent('ci-11', 11));
    const dispatchLine = makeDispatchLine({ root, decisionOf, provider: approver });
    await cycle(root, dispatchLine);
    openInbox(root).accept(ciEvent('ci-11-again', 11));
    await cycle(root, dispatchLine);
    const items = openOutbox(root).items();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], {
      id: `notice:card:11:${HASH}`,
      kind: 'notification',
      issue: 11,
      payload: {
        subtype: 'approval-request', issue: 11, category: 'destructive', question: QUESTION,
        options: ['approve', 'reject'], recommendation: 'reject', evidence: ['docs/a.md'],
      },
    });
  });
});

test('A3: the default evidence names the issue and DECISION=ask when the caller gives none', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 13, sessionId: 's-13' });
    openInbox(root).accept(ciEvent('ci-13', 13));
    await cycle(root, makeDispatchLine({ root, decisionOf: () => ({ category: 'scope', question: QUESTION }) }));
    assert.deepEqual((await readLine(root, 13)).pending.evidence, ['issue #13 DECISION=ask']);
  });
});

test('A4: the owner approve reply resumes the suspended line with its stored sessionId', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 11, sessionId: 's-11' });
    openInbox(root).accept(ciEvent('ci-11', 11));
    const dispatchLine = makeDispatchLine({ root, owner: OWNER, decisionOf, provider: approver });
    await cycle(root, dispatchLine);
    assert.equal((await readLine(root, 11)).status, 'suspended');
    openInbox(root).accept(ownerEvent('ev-approve', 11, { body: 'approve', author: OWNER, decision: 'approve' }));
    await cycle(root, dispatchLine);
    const line = await readLine(root, 11);
    assert.equal(line.status, 'running');
    assert.equal(line.sessionId, 's-11');
    assert.equal(line.pending, null);
  });
});

test('A4: an approve reply from the owner through GitHub comments resumes the line', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 11, sessionId: 's-11' });
    openInbox(root).accept(ciEvent('ci-11', 11));
    const dispatchLine = makeDispatchLine({ root, owner: OWNER, decisionOf, provider: approver });
    await cycle(root, dispatchLine);
    const reader = {
      listIssues: async () => [{ number: 11, title: 'Build it', updatedAt: '2026-01-01T00:00:02.000Z' }],
      listComments: async () => [{ id: 'IC_9', body: '  Approve\nship it', createdAt: '2026-01-01T00:00:01.500Z', author: { login: OWNER } }],
    };
    await cycle(root, dispatchLine, { reader });
    assert.equal((await readLine(root, 11)).status, 'running');
  });
});

test('A4: an approve reply from another author is ignored and the line stays suspended', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 11, sessionId: 's-11' });
    openInbox(root).accept(ciEvent('ci-11', 11));
    const dispatchLine = makeDispatchLine({ root, owner: OWNER, decisionOf, provider: approver });
    await cycle(root, dispatchLine);
    const before = await readLine(root, 11);
    openInbox(root).accept(ownerEvent('ev-other', 11, { body: 'approve', author: 'mallory', decision: 'approve' }));
    await cycle(root, dispatchLine);
    assert.deepEqual(await readLine(root, 11), before);
  });
});

test('A4: without a repo owner no approval is accepted', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 11, sessionId: 's-11' });
    openInbox(root).accept(ciEvent('ci-11', 11));
    const dispatchLine = makeDispatchLine({ root, decisionOf, provider: approver });
    await cycle(root, dispatchLine);
    openInbox(root).accept(ownerEvent('ev-none', 11, { body: 'approve', decision: 'approve' }));
    await cycle(root, dispatchLine);
    assert.equal((await readLine(root, 11)).status, 'suspended');
  });
});

test('A5: a naming card decided by the provider resumes in-line, records the decision and enqueues no notification', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    openInbox(root).accept(ciEvent('ci-12', 12));
    let asked;
    const provider = { decide: async ({ card }) => { asked = card; return { choice: 'approve', reason: 'short name', source: 'model' }; } };
    await cycle(root, makeDispatchLine({ root, decisionOf, provider }));
    assert.equal(asked.category, 'naming');
    const line = await readLine(root, 12);
    assert.equal(line.status, 'running');
    assert.equal(line.decisions.length, 1);
    assert.equal(line.decisions[0].choice, 'approve');
    assert.equal(line.decisions[0].source, 'model');
    assert.equal(openOutbox(root).items().length, 0);
  });
});

test('the default provider fails closed: a non-closed card suspends its line', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    openInbox(root).accept(ciEvent('ci-12', 12));
    await cycle(root, makeDispatchLine({ root, decisionOf }));
    const line = await readLine(root, 12);
    assert.equal(line.status, 'suspended');
    assert.equal(line.pending.reason, 'provider error: no card provider configured');
    assert.equal(openOutbox(root).items().length, 1);
  });
});

test('produceEvents keeps the comment author and reads decision from the first non-empty line only', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    const comment = (id, body) => ({ id, body, createdAt: '2026-01-01T00:00:01.000Z', author: { login: OWNER } });
    const reader = {
      listIssues: async () => [{ number: 5, title: 't', updatedAt: '2026-01-01T00:00:02.000Z' }],
      listComments: async () => [comment('c1', '\n  REJECT  \nno'), comment('c2', 'please approve'), comment('c3', 'approve')],
    };
    await produceEvents({ inbox, reader });
    const payloads = inbox.events().filter((e) => e.kind === 'owner_comment').map((e) => e.payload);
    assert.deepEqual(payloads, [
      { body: '\n  REJECT  \nno', author: OWNER, decision: 'reject' },
      { body: 'please approve', author: OWNER },
      { body: 'approve', author: OWNER, decision: 'approve' },
    ]);
  });
});
