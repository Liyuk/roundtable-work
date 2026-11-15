import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openActionJournal, ACTIONS_PATH } from '../../runtime/lib/action-journal.mjs';
import { applyActionReply, isLineHeld } from '../../runtime/lib/action-replies.mjs';
import { parseRtCommand } from '../../runtime/lib/rt-commands.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { collectStatus } from '../../runtime/lib/status.mjs';

const OWNER = 'liyuk';
const ID = 'act:config-change:5:k1';

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'action-replies-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const fakeGit = () => ({ calls: [], async createRevert(args) { this.calls.push(args); return 'revert-sha'; } });

// `journal` is bound after construction so setLabels can observe the line while a rollback runs.
const fakeGithub = (ctx = {}) => ({
  calls: [],
  labels: {},
  async setLabels({ issue, labels }) { this.calls.push(['setLabels', issue]); if (ctx.during) ctx.during(); this.labels[issue] = [...labels]; },
  async reopenIssue(issue) { this.calls.push(['reopenIssue', issue]); },
  async closeIssue(issue) { this.calls.push(['closeIssue', issue]); },
  async openRevertPullRequest(args) { this.calls.push(['openRevertPullRequest', args]); return { number: 9 }; },
});

const action = (over = {}) => ({ kind: 'config-change', issue: 5, key: 'k1', reasons: [], plan: {}, before: {}, ...over });
const reply = (body, over = {}) => ({ source_event_id: `c:${body}`, kind: 'owner_comment', issue: 5, payload: { body, author: OWNER }, receivedAt: 1, ...over });
const records = (root) => readFileSync(join(root, ACTIONS_PATH), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Performs one action on issue 5 with the labels recorded before, so rollback has a recipe (labels-restore).
const executed = async (journal, over = {}) => {
  const { id } = await journal.perform({
    action: action({ before: { labels: ['rt:running'] }, sessionId: 'sess-1', ...over }),
    tier: 'auto-notify', notify() {}, apply: async () => ({}),
  });
  return id;
};

test('parseRtCommand accepts action commands, refuses merge, and refuses other shapes with a reason', () => {
  assert.deepEqual(parseRtCommand(`/rt confirm ${ID}`), { ok: true, command: 'confirm', actionId: ID });
  assert.deepEqual(parseRtCommand(`/rt rollback ${ID}`), { ok: true, command: 'rollback', actionId: ID });
  assert.deepEqual(parseRtCommand(`/rt amend ${ID} keep the  second   line`), { ok: true, command: 'amend', actionId: ID, text: 'keep the  second   line' });
  assert.match(parseRtCommand('/rt merge 5').reason, /merge is not accepted from \/rt/);
  assert.match(parseRtCommand('/rt merge').reason, /merge is not accepted from \/rt/);
  for (const text of [`/rt confirm`, `/rt rollback`, `/rt confirm ${ID} extra`, `/rt rollback ${ID} extra`, `/rt amend ${ID}`, `/rt amend`, '/rt pause now', '/rt approve 5', `/rt fly ${ID}`]) {
    const r = parseRtCommand(text);
    assert.equal(r.ok, false, text);
    assert.equal(typeof r.reason, 'string');
  }
});

test('confirm settles an executed action with no git, GitHub or outbox effect', async () => {
  await withRoot(async (root) => {
    const git = fakeGit();
    const github = fakeGithub();
    const journal = openActionJournal(root, { git, github });
    const id = await executed(journal);
    const inbox = openInbox(root);
    const out = await applyActionReply({ root, journal, inbox, owner: OWNER, event: reply(`/rt confirm ${id}`) });
    assert.equal(out.outcome, 'applied');
    assert.equal(journal.state(id), 'settled');
    assert.deepEqual(git.calls, []);
    assert.deepEqual(github.calls, []);
    assert.deepEqual(openOutbox(root).items(), []);
  });
});

test('rollback holds the line while reverting, restores labels, and enqueues one rollback-result', async () => {
  await withRoot(async (root) => {
    const seen = [];
    const github = fakeGithub({ during: () => seen.push(isLineHeld(journal, 5)) });
    const journal = openActionJournal(root, { git: fakeGit(), github });
    const id = await executed(journal);
    github.labels[5] = ['rt:done'];
    const inbox = openInbox(root);
    const out = await applyActionReply({ root, journal, inbox, owner: OWNER, event: reply(`/rt rollback ${id}`) });
    assert.equal(out.outcome, 'applied');
    assert.deepEqual(seen, [true]);
    assert.equal(isLineHeld(journal, 5), false);
    assert.equal(journal.state(id), 'rolled_back');
    assert.deepEqual(github.labels[5], ['rt:running']);
    const items = openOutbox(root).items();
    assert.equal(items.length, 1);
    assert.deepEqual(items[0], { id: `notice:action:${id}:rolled_back`, kind: 'notification', issue: 5, payload: { subtype: 'rollback-result', actionId: id, state: 'rolled_back' } });
  });
});

test('amend moves the action to amend_requested, queues the text on the line, and the next action records amends', async () => {
  await withRoot(async (root) => {
    const journal = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    const id = await executed(journal);
    const inbox = openInbox(root);
    const out = await applyActionReply({ root, journal, inbox, owner: OWNER, event: reply(`/rt amend ${id} use a smaller diff`), now: () => 42 });
    assert.equal(out.outcome, 'applied');
    assert.equal(journal.state(id), 'amend_requested');
    const events = inbox.events();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'owner_comment');
    assert.equal(events[0].issue, 5);
    assert.deepEqual(events[0].payload, { command: 'amend', actionId: id, text: 'use a smaller diff', sessionId: 'sess-1', author: OWNER });
    assert.equal(journal.pendingAmend(5), id);

    const next = await journal.perform({ action: action({ key: 'k2', amends: id }), tier: 'auto-silent', notify() {}, apply: async () => ({}) });
    assert.equal(next.state, 'settled');
    assert.equal(records(root).find((r) => r.id === next.id).amends, id);
    assert.equal(journal.state(id), 'amended');
    assert.equal(journal.pendingAmend(5), undefined);
  });
});

test('unknown id, illegal state, empty amend text and a non-owner author are ignored and change nothing', async () => {
  await withRoot(async (root) => {
    const journal = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    const id = await executed(journal);
    await applyActionReply({ root, journal, inbox: openInbox(root), owner: OWNER, event: reply(`/rt confirm ${id}`) });
    const before = { records: records(root).length, outbox: openOutbox(root).items().length, inbox: openInbox(root).events().length };
    const cases = [
      reply('/rt confirm act:config-change:5:none'),
      reply(`/rt rollback ${id}`), // settled: illegal
      reply(`/rt amend ${id} text`), // settled: illegal
      reply(`/rt confirm ${id}`, { payload: { body: `/rt confirm ${id}`, author: 'mallory' } }),
    ];
    for (const event of cases) {
      const out = await applyActionReply({ root, journal, inbox: openInbox(root), owner: OWNER, event });
      assert.equal(out.outcome, 'ignored', event.payload.body);
      assert.equal(typeof out.reason, 'string');
    }
    assert.deepEqual({ records: records(root).length, outbox: openOutbox(root).items().length, inbox: openInbox(root).events().length }, before);
    assert.equal(journal.state(id), 'settled');
  });
});

test('collectStatus lists actions awaiting confirmation, approval or revert_failed, and not settled ones', async () => {
  await withRoot(async (root) => {
    const github = fakeGithub();
    github.setLabels = async () => { throw new Error('label service down'); };
    const journal = openActionJournal(root, { git: fakeGit(), github });
    const pending = await executed(journal, { key: 'pending' });
    const approval = await journal.perform({ action: action({ key: 'approval' }), tier: 'approve-first', notify() {}, apply: async () => ({}) });
    const failed = await executed(journal, { key: 'failed' });
    await journal.rollback(failed, { notify() {} });
    await journal.perform({ action: action({ key: 'settled' }), tier: 'auto-silent', notify() {}, apply: async () => ({}) });
    const workRoot = join(root, '.roundtable');
    const snapshot = await collectStatus({ workRoot, sources: { github: async () => ({ issues: [], queue: [] }), local: async () => ({ issues: [] }) } });
    assert.deepEqual(snapshot.actions.map((a) => [a.id, a.state]).sort(), [
      [approval.id, 'awaiting_approval'],
      [failed, 'revert_failed'],
      [pending, 'executed_pending_confirmation'],
    ].sort());
    assert.deepEqual(Object.keys(snapshot.actions[0]), ['id', 'kind', 'issue', 'state']);
  });
});
