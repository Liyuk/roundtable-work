import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openActionJournal, buildRevert, ACTIONS_PATH } from '../../runtime/lib/action-journal.mjs';

const DAY = 24 * 60 * 60 * 1000;
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'action-journal-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const fakeGit = () => ({
  calls: [],
  async createRevert(args) { this.calls.push(args); return 'revert-sha'; },
});

const fakeGithub = () => ({
  calls: [],
  labels: {},
  async setLabels({ issue, labels }) { this.calls.push(['setLabels', issue]); this.labels[issue] = [...labels]; },
  async reopenIssue(issue) { this.calls.push(['reopenIssue', issue]); },
  async closeIssue(issue) { this.calls.push(['closeIssue', issue]); },
  async openRevertPullRequest(args) { this.calls.push(['openRevertPullRequest', args]); return { number: 9 }; },
});

const action = (over = {}) => ({ kind: 'config-change', issue: 5, key: 'k1', reasons: [], plan: {}, before: {}, ...over });

const writeWorkspaceFile = (root, rel, text) => {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), text);
};

const records = (root) => readFileSync(join(root, ACTIONS_PATH), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the journal path is fixed', () => {
  assert.equal(ACTIONS_PATH, '.roundtable/state/actions.jsonl');
});

test('auto-silent applies, settles, and sends no notice', async () => {
  await withRoot(async (root) => {
    const journal = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    const notices = [];
    let applied = 0;
    const result = await journal.perform({
      action: action(), tier: 'auto-silent', notify: (n) => notices.push(n),
      apply: async () => { applied++; },
    });
    assert.equal(applied, 1);
    assert.equal(result.state, 'settled');
    assert.deepEqual(notices, []);
  });
});

test('auto-notify writes the action record before apply, then notifies once', async () => {
  await withRoot(async (root) => {
    const journal = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    const notices = [];
    let seenBeforeApply = false;
    const result = await journal.perform({
      action: action(), tier: 'auto-notify', notify: (n) => notices.push(n),
      apply: async () => { seenBeforeApply = records(root).some((r) => r.type === 'action'); },
    });
    assert.equal(seenBeforeApply, true);
    assert.equal(result.id, 'act:config-change:5:k1');
    assert.equal(journal.state(result.id), 'executed_pending_confirmation');
    assert.deepEqual(notices.map((n) => n.id), ['notice:action:act:config-change:5:k1:executed_pending_confirmation']);
  });
});

test('approve-first does not apply and sends one approval-request', async () => {
  await withRoot(async (root) => {
    const journal = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    const notices = [];
    let applied = 0;
    const result = await journal.perform({
      action: action(), tier: 'approve-first', notify: (n) => notices.push(n),
      apply: async () => { applied++; },
    });
    assert.equal(applied, 0);
    assert.equal(journal.state(result.id), 'awaiting_approval');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].subtype, 'approval-request');
  });
});

test('a replayed perform for the same id does not apply twice, also after reopening', async () => {
  await withRoot(async (root) => {
    const notices = [];
    let applied = 0;
    const run = (journal) => journal.perform({
      action: action(), tier: 'auto-notify', notify: (n) => notices.push(n),
      apply: async () => { applied++; },
    });
    const first = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    await run(first);
    await run(first);
    const reopened = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    const again = await run(reopened);
    assert.equal(applied, 1);
    assert.equal(notices.length, 1);
    assert.equal(again.state, 'executed_pending_confirmation');
    assert.equal(reopened.state('act:config-change:5:k1'), 'executed_pending_confirmation');
  });
});

test('buildRevert returns ordered steps from the closed set, or false without a recipe', () => {
  const steps = buildRevert(
    { kind: 'merge', issue: 7 },
    { labels: ['rt:running'], file: { path: 'a.json', sha256: 'h' }, issueState: 'open' },
  );
  assert.deepEqual(steps, [
    { step: 'git-revert-merge', mergeCommit: null },
    { step: 'labels-restore', issue: 7, labels: ['rt:running'] },
    { step: 'file-restore', path: 'a.json', sha256: 'h' },
    { step: 'issue-reopen', issue: 7 },
  ]);
  assert.deepEqual(buildRevert({ kind: 'comment', issue: 7 }, {}), false);
  assert.deepEqual(buildRevert({ kind: 'config-change', issue: 7 }, { issueState: 'closed' }), [{ step: 'issue-close', issue: 7 }]);
});

test('rollback restores labels and the file to the snapshot', async () => {
  await withRoot(async (root) => {
    writeWorkspaceFile(root, 'config/limits.json', '{"a":1}');
    const github = fakeGithub();
    github.labels[5] = ['rt:running'];
    const git = fakeGit();
    const journal = openActionJournal(root, { git, github });
    const { id } = await journal.perform({
      action: action({ before: { labels: ['rt:running'], file: 'config/limits.json' } }),
      tier: 'auto-notify', notify() {},
      apply: async () => {
        github.labels[5] = ['rt:done'];
        writeWorkspaceFile(root, 'config/limits.json', '{"a":2}');
        return {};
      },
    });
    const result = await journal.rollback(id, { notify() {} });
    assert.equal(result.state, 'rolled_back');
    assert.equal(journal.state(id), 'rolled_back');
    assert.deepEqual(github.labels[5], ['rt:running']);
    assert.equal(readFileSync(join(root, 'config/limits.json'), 'utf8'), '{"a":1}');
  });
});

test('a revert merge opens a revert PR like recoverRedMain does', async () => {
  await withRoot(async (root) => {
    const git = fakeGit();
    const github = fakeGithub();
    const journal = openActionJournal(root, { git, github });
    const { id } = await journal.perform({
      action: action({ kind: 'merge', issue: 7, before: {} }),
      tier: 'auto-notify', notify() {},
      apply: async () => ({ mergeCommit: SHA }),
    });
    assert.equal((await journal.rollback(id, { notify() {} })).state, 'rolled_back');
    assert.deepEqual(git.calls, [{ mergeCommit: SHA, branch: 'rt/revert-abcdef1' }]);
    assert.equal(github.calls[0][0], 'openRevertPullRequest');
    assert.deepEqual(github.calls[0][1], { branch: 'rt/revert-abcdef1', revert: 'revert-sha', title: 'Revert abcdef1 after red main' });
  });
});

test('a failed step stops the rollback, notifies once, and a retry skips completed steps', async () => {
  await withRoot(async (root) => {
    writeWorkspaceFile(root, 'config/limits.json', '{"a":1}');
    const github = fakeGithub();
    const journal = openActionJournal(root, { git: fakeGit(), github });
    const notices = [];
    const { id } = await journal.perform({
      action: action({ before: { labels: ['rt:running'], file: 'config/limits.json', issueState: 'open' } }),
      tier: 'auto-notify', notify: (n) => notices.push(n),
      apply: async () => { writeWorkspaceFile(root, 'config/limits.json', '{"a":2}'); return {}; },
    });
    writeWorkspaceFile(root, 'config/limits.json', '{"a":3}'); // a later change, not the post-action content
    const first = await journal.rollback(id, { notify: (n) => notices.push(n) });
    assert.equal(first.state, 'revert_failed');
    assert.equal(journal.state(id), 'revert_failed');
    assert.equal(github.calls.filter((c) => c[0] === 'reopenIssue').length, 0);
    assert.equal(readFileSync(join(root, 'config/limits.json'), 'utf8'), '{"a":3}');
    assert.deepEqual(notices.filter((n) => n.subtype === 'approval-request').map((n) => n.id), [`notice:action:${id}:revert_failed`]);

    writeWorkspaceFile(root, 'config/limits.json', '{"a":2}'); // the post-action content is back
    const retry = await journal.rollback(id, { notify() {} });
    assert.equal(retry.state, 'rolled_back');
    assert.equal(github.calls.filter((c) => c[0] === 'setLabels').length, 1);
    assert.equal(github.calls.filter((c) => c[0] === 'reopenIssue').length, 1);
  });
});

test('file-restore refuses a path that escapes the workspace', async () => {
  await withRoot(async (root) => {
    const journal = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    await assert.rejects(journal.perform({
      action: action({ before: { file: '../outside.json' } }),
      tier: 'auto-notify', notify() {}, apply: async () => ({}),
    }), TypeError);
    assert.equal(existsSync(join(root, ACTIONS_PATH)), false);
  });
});

test('expire moves old pending entries to expired and reverts nothing', async () => {
  await withRoot(async (root) => {
    const t0 = 1_700_000_000_000;
    let now = t0;
    const github = fakeGithub();
    const journal = openActionJournal(root, { git: fakeGit(), github, now: () => now });
    const old = await journal.perform({ action: action({ key: 'old' }), tier: 'auto-notify', notify() {}, apply: async () => ({}) });
    now = t0 + 2 * DAY;
    const fresh = await journal.perform({ action: action({ key: 'fresh' }), tier: 'auto-notify', notify() {}, apply: async () => ({}) });
    now = t0 + 8 * DAY;
    assert.deepEqual(await journal.expire(now, 7), [old.id]);
    assert.equal(journal.state(old.id), 'expired');
    assert.equal(journal.state(fresh.id), 'executed_pending_confirmation');
    assert.deepEqual(github.calls, []);
  });
});

test('perform stores sessionId and amends only when given, and confirm settles the record', async () => {
  await withRoot(async (root) => {
    const journal = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    const plain = await journal.perform({ action: action({ key: 'p' }), tier: 'auto-notify', notify() {}, apply: async () => ({}) });
    const linked = await journal.perform({ action: action({ key: 'q', sessionId: 's-7', amends: plain.id }), tier: 'auto-notify', notify() {}, apply: async () => ({}) });
    const [a, b] = records(root).filter((r) => r.type === 'action');
    assert.equal('sessionId' in a, false);
    assert.equal('amends' in a, false);
    assert.equal(b.sessionId, 's-7');
    assert.equal(b.amends, plain.id);
    assert.equal(journal.pendingAmend(5), undefined);
    journal.confirm(linked.id);
    assert.equal(journal.state(linked.id), 'settled');
    await assert.rejects(async () => journal.confirm(linked.id), /cannot confirm from settled/);
  });
});

test('requestAmend moves a pending action to amend_requested and pendingAmend finds it by issue', async () => {
  await withRoot(async (root) => {
    const journal = openActionJournal(root, { git: fakeGit(), github: fakeGithub() });
    const { id } = await journal.perform({ action: action(), tier: 'auto-notify', notify() {}, apply: async () => ({}) });
    journal.requestAmend(id);
    assert.equal(journal.state(id), 'amend_requested');
    assert.equal(journal.pendingAmend(5), id);
    assert.equal(journal.pendingAmend(6), undefined);
    assert.deepEqual(journal.list().map((a) => [a.id, a.state, a.issue]), [[id, 'amend_requested', 5]]);
  });
});
