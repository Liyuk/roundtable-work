import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { applyDecision, parseDecisionFile, resumeAfterOwnerReply } from '../../runtime/lib/decisions.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { runQueue } from '../../runtime/rtd.mjs';

async function fixture(fn) {
  const scratch = join(process.cwd(), '.roundtable/scratch/96-core-decisions-dev-1');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'case-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function client() {
  const events = [];
  return { events, addLabel: async (id, label) => events.push(['addLabel', id, label]), removeLabel: async (id, label) => events.push(['removeLabel', id, label]), createComment: async (id, body) => { events.push(['createComment', id, body]); return { id: 9, createdAt: '2026-01-01T00:00:00Z' }; }, listComments: async () => [] };
}

test('validates the decision object and the closed ask category list', async () => {
  for (const decision of [null, {}, { decision: 'ask', category: 'merge', question: 'May I?' }, { decision: 'ask', category: 'scope' }]) {
    await assert.rejects(applyDecision({ decision, issue: { number: 7 }, store: {}, client: client() }), TypeError);
  }
  for (const category of ['scope', 'credentials', 'destructive', 'direction']) {
    assert.equal((await applyDecision({ decision: { decision: 'ask', category, question: 'Question?' }, issue: { number: 7 }, store: { update: async () => ({}) }, client: client() })).status, 'waiting_person');
  }
});

test('parses the frozen decision-file lines and rejects malformed terms or ask categories', () => {
  assert.deepEqual(parseDecisionFile('DECISION=do\nContinue the task\n'), { decision: 'do', reason: 'Continue the task' });
  assert.deepEqual(parseDecisionFile('DECISION=continue\nContinue the task\n'), { decision: 'continue', reason: 'Continue the task' });
  assert.deepEqual(parseDecisionFile('DECISION=ask\nscope\nMay I expand scope?\n'), { decision: 'ask', category: 'scope', question: 'May I expand scope?' });
  assert.deepEqual(parseDecisionFile('DECISION=out-of-scope\nOutside the authorized scope'), { decision: 'out-of-scope', reason: 'Outside the authorized scope' });
  for (const input of ['DECISION=merge\nReason', 'DECISION=ask\nmerge\nQuestion', 'DECISION=ask\nscope']) assert.throws(() => parseDecisionFile(input), TypeError);
});

test('do durably queues the next daemon turn and clears stale pause labels', async () => fixture(async root => {
  const store = await createStateStore({ workRoot: root });
  await store.update('7', s => { s.status = 'waiting_person'; s.pause = { marker: '<!-- rt:ask -->' }; });
  const tracker = client();
  await applyDecision({ decision: { decision: 'do', reason: 'continue work' }, issue: { number: 7 }, store, client: tracker, now: () => 123 });
  const state = await store.load('7');
  assert.equal(state.status, 'queued'); assert.equal(state.pause, undefined); assert.deepEqual(state.checkpoint, null);
  assert.deepEqual(tracker.events, [['removeLabel', 7, 'rt:ask'], ['removeLabel', 7, 'rt:blocked']]);
}));

test('a do outcome survives the current wake and the next daemon pass resumes from developing', async () => fixture(async root => {
  const phases = [];
  let first = true;
  const handler = async ({ phase }) => {
    phases.push(phase);
    if (phase === 'finalizing' && first) { first = false; return { exitCode: 0, decision: { decision: 'do', reason: 'continue' } }; }
    if (phase === 'reviewing') return { exitCode: 0, output: '审查结论：通过' };
    return { exitCode: 0, output: 'ok' };
  };
  const firstPass = await runQueue({ workRoot: root, queue: ['17'], handler });
  assert.equal(firstPass.outcomes[0].status, 'queued');
  assert.equal((await createStateStore({ workRoot: root }).then(store => store.load('17'))).status, 'queued');
  const secondPass = await runQueue({ workRoot: root, queue: ['17'], handler });
  assert.equal(secondPass.outcomes[0].status, 'done');
  assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing', 'developing', 'testing', 'reviewing', 'finalizing']);
}));

test('daemon parses and applies a valid decision file from the finalizing result', async () => fixture(async root => {
  const phases = [];
  const handler = async ({ phase }) => {
    phases.push(phase);
    if (phase === 'finalizing') return { exitCode: 0, decisionFile: 'DECISION=do\nContinue the task' };
    if (phase === 'reviewing') return { exitCode: 0, output: '审查结论：通过' };
    return { exitCode: 0, output: 'ok' };
  };
  const result = await runQueue({ workRoot: root, queue: ['18'], handler });
  assert.equal(result.outcomes[0].status, 'queued');
  assert.equal(result.outcomes[0].decision, 'do');
  assert.equal((await createStateStore({ workRoot: root }).then(store => store.load('18'))).status, 'queued');
  assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing']);
}));

test('daemon rejects an invalid decision file without applying it', async () => fixture(async root => {
  const handler = async ({ phase }) => phase === 'finalizing'
    ? { exitCode: 0, decisionFile: 'DECISION=ask\nmerge\nMay I?' }
    : { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' };
  await assert.rejects(runQueue({ workRoot: root, queue: ['19'], handler }), /ask category must be scope, credentials, destructive, or direction/);
  const state = await createStateStore({ workRoot: root }).then(store => store.load('19'));
  assert.notEqual(state.status, 'waiting_person');
}));

test('ask writes the exact comment and rt:ask through the injected client, then resumes on owner reply', async () => fixture(async root => {
  const store = await createStateStore({ workRoot: root }); const tracker = client();
  await applyDecision({ decision: { decision: 'ask', category: 'scope', question: 'Expand scope?' }, issue: { number: 8, author: { login: 'owner' } }, store, client: tracker, now: () => 123 });
  assert.deepEqual(tracker.events, [
    ['createComment', 8, '<!-- rt:ask -->\nDECISION=ask\nscope\nExpand scope?'],
    ['addLabel', 8, 'rt:ask'],
    ['removeLabel', 8, 'rt:running'],
  ]);
  assert.equal((await store.load('8')).status, 'waiting_person');
  const reply = { id: 10, author: { login: 'owner' }, createdAt: '2026-01-02T00:00:00Z', body: 'Proceed' };
  assert.equal(await resumeAfterOwnerReply({ issue: { number: 8, author: { login: 'owner' } }, comments: [reply], store, client: tracker, now: () => 456 }), true);
  assert.equal((await store.load('8')).status, 'queued');
  assert.deepEqual(tracker.events.slice(-2), [['removeLabel', 8, 'rt:ask'], ['removeLabel', 8, 'rt:blocked']]);
}));

test('a second ask waits for a reply to its own comment', async () => fixture(async root => {
  const store = await createStateStore({ workRoot: root });
  const comments = [];
  let nextId = 10;
  let commentTime = '2026-01-01T00:00:00Z';
  const tracker = {
    events: [],
    addLabel: async (id, label) => tracker.events.push(['addLabel', id, label]),
    removeLabel: async (id, label) => tracker.events.push(['removeLabel', id, label]),
    createComment: async (id, body) => {
      const comment = { id: nextId, body, createdAt: commentTime };
      nextId += 10;
      comments.push(comment);
      tracker.events.push(['createComment', id, body]);
      return comment;
    },
    listComments: async () => comments,
  };
  const issue = { number: 20, author: { login: 'owner' } };
  await applyDecision({ decision: { decision: 'ask', category: 'scope', question: 'First?' }, issue, store, client: tracker, now: () => Date.parse('2026-01-01T00:00:00Z') });
  const oldReply = { id: 15, author: issue.author, createdAt: '2026-01-02T00:00:00Z', body: 'Proceed' };
  comments.push(oldReply);
  assert.equal(await resumeAfterOwnerReply({ issue, comments, store, client: tracker }), true);

  commentTime = '2026-01-05T00:00:00Z';
  await applyDecision({ decision: { decision: 'ask', category: 'direction', question: 'Second?' }, issue, store, client: tracker, now: () => Date.parse(commentTime) });
  assert.equal(comments.filter(comment => comment.body?.includes('<!-- rt:ask -->')).length, 2);
  assert.equal(await resumeAfterOwnerReply({ issue, comments: [comments[0], oldReply], store, client: tracker }), false);
  assert.equal((await store.load('20')).status, 'waiting_person');

  const freshReply = { id: 25, author: issue.author, createdAt: '2026-01-07T00:00:00Z', body: 'Approved' };
  assert.equal(await resumeAfterOwnerReply({ issue, comments: [...comments, freshReply], store, client: tracker }), true);
  assert.equal((await store.load('20')).status, 'queued');
}));

test('out-of-scope comments and applies rt:blocked without closing the issue', async () => fixture(async root => {
  const store = await createStateStore({ workRoot: root }); const tracker = client();
  const issue = { number: 9, state: 'OPEN' };
  await applyDecision({ decision: { decision: 'out-of-scope', reason: 'Outside authorization' }, issue, store, client: tracker });
  assert.deepEqual(tracker.events, [
    ['createComment', 9, '<!-- rt:out-of-scope -->\nDECISION=out-of-scope\nOutside authorization'],
    ['addLabel', 9, 'rt:blocked'],
    ['removeLabel', 9, 'rt:running'],
  ]);
  assert.equal(issue.state, 'OPEN'); assert.equal((await store.load('9')).status, 'out-of-scope');
}));
