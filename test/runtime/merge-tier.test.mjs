import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadAutonomy, autonomyTier } from '../../runtime/lib/autonomy.mjs';
import { ApprovalRequired } from '../../runtime/lib/merge.mjs';
import { readMergeTiers } from '../../runtime/lib/merge-mode.mjs';
import { createTieredMerge, hostMergeRefusal, mergeTierOf, recordTieredMerge } from '../../runtime/lib/merge-tier.mjs';
import { runGates } from '../../runtime/lib/gates.mjs';
import { openActionJournal } from '../../runtime/lib/action-journal.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { safetyFiles } from '../../runtime/lib/safety.mjs';
import { buildPrRecord, upsertPrRecord } from '../../runtime/lib/pr-record.mjs';

// Seams: readMergeTiers(config), createTieredMerge (flag on or off, the daemon's entry point), recordTieredMerge (journal and notice),
// mergeTierOf (tier input from the live pull request). Autonomy comes from the shipped defaults and a missing or temp host file;
// the real home is never read.
const DEFAULTS = resolve(import.meta.dirname, '../../runtime/defaults/autonomy.json');
const MISSING = '/nonexistent/rt-merge-tier-host.json';
const ISSUE = '380';
const HEAD = 'abc1234';
const MERGE_ID = `act:merge:${ISSUE}:${HEAD}`;
const NOTICE_ID = `notice:action:${MERGE_ID}:executed_pending_confirmation`;
const RECORD_BODY = upsertPrRecord('', buildPrRecord({ issue: ISSUE, head: HEAD, tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'] }));
const EVIDENCE = { issue: ISSUE, head: HEAD, tree: 'tree-a', highRisk: false, passed: ['gate0', 'gate1', 'ci'], ciGreen: true };

const shippedAutonomy = async (hostPath = MISSING) => (await loadAutonomy({ defaultsPath: DEFAULTS, hostPath })).autonomy;

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'merge-tier-test-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// A green merge of `files`, through the same entry point the daemon builds. The fake GitHub records each squash.
async function mergeFixture(root, { enabled = true, files = ['runtime/lib/x.mjs'], labels = [], safetyApproved = false, revertOf } = {}) {
  const squashes = [];
  const github = {
    async getPullRequest() { return { state: 'open', draft: false, head: HEAD, mergeable: true, files, labels, body: RECORD_BODY }; },
    async requiredGreen() { return true; },
    async squashMerge(_pr, options) { squashes.push(options); return { mergeCommit: 'f00dfeed' }; },
  };
  const gateState = { async get() { return { issue: ISSUE, head: HEAD, tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'], safetyFiles: safetyFiles(files), safetyApproved }; } };
  const squash = createTieredMerge({ enabled, autonomy: await shippedAutonomy(), root, revertOf, github, gateState, mode: 'agent' });
  return { squash, squashes };
}

test('readMergeTiers is on only for an explicit true, and the shipped config is off', async () => {
  const config = (text) => async () => text;
  assert.equal(await readMergeTiers({ readFile: async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }, repoRoot: '/repo' }), false);
  assert.equal(await readMergeTiers({ readFile: config('{ "mergeMode": "agent" }'), repoRoot: '/repo' }), false);
  assert.equal(await readMergeTiers({ readFile: config('{ "mergeTiers": false }'), repoRoot: '/repo' }), false);
  assert.equal(await readMergeTiers({ readFile: config('{ "mergeTiers": "true" }'), repoRoot: '/repo' }), false);
  assert.equal(await readMergeTiers({ readFile: config('{ "mergeTiers": '), repoRoot: '/repo' }), false);
  assert.equal(await readMergeTiers({ readFile: config('{ "mergeTiers": true }'), repoRoot: '/repo' }), true);
  assert.equal(await readMergeTiers(), false);
});

test('flag off: no tier is applied, so an owner-override label still merges and nothing is journaled', async () => {
  await withRoot(async (root) => {
    const f = await mergeFixture(root, { enabled: false, labels: ['rt:tier-approve'] });
    assert.deepEqual(await f.squash(ISSUE, EVIDENCE), { mergeCommit: 'f00dfeed' });
    assert.equal(f.squashes.length, 1);
    assert.equal(openActionJournal(root).state(MERGE_ID), undefined);
    assert.equal(openOutbox(root).items().length, 0);
  });
});

test('approve-first: the owner-override label throws ApprovalRequired, never squashes, and records nothing', async () => {
  await withRoot(async (root) => {
    const f = await mergeFixture(root, { labels: ['rt:tier-approve'] });
    await assert.rejects(f.squash(ISSUE, EVIDENCE), (err) => err instanceof ApprovalRequired && err.message.includes('owner-override'));
    assert.equal(f.squashes.length, 0);
    assert.equal(openActionJournal(root).state(MERGE_ID), undefined);
  });
});

test('auto-notify: merges, journals the merge as pending confirmation, and enqueues one notice', async () => {
  await withRoot(async (root) => {
    const f = await mergeFixture(root);
    assert.deepEqual(await f.squash(ISSUE, EVIDENCE), { mergeCommit: 'f00dfeed' });
    assert.equal(f.squashes.length, 1);
    assert.equal(openActionJournal(root).state(MERGE_ID), 'executed_pending_confirmation');
    assert.deepEqual(openOutbox(root).items().map((item) => [item.id, item.payload.subtype]), [[NOTICE_ID, 'action-pending-confirmation']]);
  });
});

test('auto-silent: records a settled merge with no notice', async () => {
  await withRoot(async (root) => {
    const squash = recordTieredMerge(async () => ({ tier: 'auto-silent', reasons: [], result: { mergeCommit: 'f00dfeed' } }), root);
    assert.deepEqual(await squash(ISSUE, EVIDENCE), { mergeCommit: 'f00dfeed' });
    assert.equal(openActionJournal(root).state(MERGE_ID), 'settled');
    assert.equal(openOutbox(root).items().length, 0);
  });
});

test('a held or replayed merge is not journaled as merged', async () => {
  await withRoot(async (root) => {
    const squash = recordTieredMerge(async () => ({ held: 'owner', mode: 'owner' }), root);
    assert.deepEqual(await squash(ISSUE, EVIDENCE), { held: 'owner', mode: 'owner' });
    assert.equal(openActionJournal(root).state(MERGE_ID), undefined);
  });
});

test('safety file: the existing safety approval still applies, and an approved safety file is approve-first', async () => {
  await withRoot(async (root) => {
    const unapproved = await mergeFixture(root, { files: ['.github/workflows/check.yml'] });
    await assert.rejects(unapproved.squash(ISSUE, EVIDENCE), /Safety-file approval is missing/);
    const approved = await mergeFixture(root, { files: ['.github/workflows/check.yml'], safetyApproved: true });
    await assert.rejects(approved.squash(ISSUE, EVIDENCE), (err) => err instanceof ApprovalRequired && err.message.includes('safety-file:.github/workflows/check.yml'));
    assert.equal(unapproved.squashes.length + approved.squashes.length, 0);
  });
});

test('a revert is never auto-silent: it is auto-notify and journaled as pending confirmation', async () => {
  await withRoot(async (root) => {
    const f = await mergeFixture(root, { revertOf: 'merge:f00dfeed' });
    await f.squash(ISSUE, EVIDENCE);
    assert.equal(openActionJournal(root).state(MERGE_ID), 'executed_pending_confirmation');
    assert.deepEqual(mergeTierOf(await shippedAutonomy(), 'merge:f00dfeed')(EVIDENCE, { files: ['docs/a.md'], labels: [] }), { tier: 'auto-notify', reasons: [] });
  });
});

test('refused loose host override: the host file cannot widen silent paths, kinds, or the approver', async () => {
  await withRoot(async (root) => {
    const hostPath = join(root, 'autonomy.json');
    await writeFile(hostPath, JSON.stringify({ silentPaths: ['bin/**'], kinds: ['merge', 'release'], safetyApprover: 'anyone' }));
    const loaded = await loadAutonomy({ defaultsPath: DEFAULTS, hostPath });
    assert.deepEqual(loaded.ignored, ['silentPaths:bin/**', 'kinds:release', 'safetyApprover']);
    assert.deepEqual(loaded.autonomy, { ...await shippedAutonomy(), kinds: ['merge'], silentPaths: [] });
    assert.deepEqual(autonomyTier({ kind: 'merge', paths: ['bin/gh'], labels: [], risk: 'risk:low' }, loaded.autonomy), { tier: 'approve-first', reasons: ['safety-file:bin/gh'], approver: 'decider' });
  });
});

test('the owner override is read from live labels: a pull request without labels fails closed, never merges', async () => {
  await withRoot(async (root) => {
    const squashes = [];
    const github = {
      async getPullRequest() { return { state: 'open', draft: false, head: HEAD, mergeable: true, files: ['runtime/lib/x.mjs'], body: RECORD_BODY }; },
      async requiredGreen() { return true; },
      async squashMerge(_pr, options) { squashes.push(options); return { mergeCommit: 'f00dfeed' }; },
    };
    const gateState = { async get() { return { issue: ISSUE, head: HEAD, tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'], safetyFiles: [], safetyApproved: false }; } };
    const autonomy = await shippedAutonomy();
    const squash = createTieredMerge({ enabled: true, autonomy, root, github, gateState, mode: 'agent' });
    await assert.rejects(squash(ISSUE, EVIDENCE), /labels are required/);
    assert.equal(squashes.length, 0);
    assert.equal(openActionJournal(root).state(MERGE_ID), undefined);
    assert.throws(() => mergeTierOf(autonomy, undefined)(EVIDENCE, { files: ['docs/a.md'] }), /labels are required/);
  });
});

test('an approve-first merge through runGates ends as a failed gate: no squash and no executed journal record', async () => {
  await withRoot(async (root) => {
    const squashes = [];
    const gateRecords = new Map();
    const body = `${RECORD_BODY}\nCloses #${ISSUE}`;
    const github = {
      async getPullRequest() { return { state: 'open', draft: false, head: HEAD, mergeable: true, files: ['runtime/lib/x.mjs'], labels: ['rt:tier-approve'], body }; },
      async requiredGreen() { return true; },
      async squashMerge(_pr, options) { squashes.push(options); return { mergeCommit: 'f00dfeed' }; },
      async recordedEscalationApproval() { return null; },
      async addLabel() {},
    };
    const state = { async get(id) { return gateRecords.get(id); }, async put(id, value) { gateRecords.set(id, structuredClone(value)); } };
    const squash = createTieredMerge({ enabled: true, autonomy: await shippedAutonomy(), root, github, gateState: state, mode: 'agent' });
    const gates = {
      async gate0() { return { passed: true }; },
      async reviewer() { return { passed: true, head: HEAD, rationale: 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.' }; },
    };
    const input = { issue: ISSUE, head: HEAD, tree: 'tree-a', highRisk: false, changedFiles: ['runtime/lib/x.mjs'], pr: 90, models: {}, state, store: null, gates,
      ci: { async requiredGreen() { return { green: true }; } }, merge: { squash }, github };
    await assert.rejects(runGates(input), (err) => err instanceof ApprovalRequired && err.message.includes('owner-override'));
    assert.equal(squashes.length, 0);
    assert.equal(openActionJournal(root).state(MERGE_ID), undefined);
  });
});

test('host outbox merges use the daemon enable key and tierOf: off reads no pull request; on refuses approve-first only', async () => {
  const autonomy = () => loadAutonomy({ defaultsPath: DEFAULTS, hostPath: MISSING });
  let reads = 0;
  const readLive = (labels) => async () => { reads += 1; return { files: ['runtime/lib/x.mjs'], labels }; };
  const args = { evidence: { highRisk: false }, autonomy };
  assert.equal(await hostMergeRefusal({ ...args, readLive: readLive(['rt:tier-approve']), tiers: async () => false }), null);
  assert.equal(reads, 0);
  assert.equal(await hostMergeRefusal({ ...args, readLive: readLive(['rt:tier-approve']), tiers: async () => true }), 'approval required: owner-override');
  assert.equal(await hostMergeRefusal({ ...args, readLive: readLive([]), tiers: async () => true }), null);
  assert.equal(await hostMergeRefusal({ ...args, evidence: { highRisk: true }, readLive: readLive([]), tiers: async () => true }), 'approval required: risk-high');
  assert.equal(await hostMergeRefusal({ ...args, readLive: async () => ({ files: ['bin/gh'], labels: [] }), tiers: async () => true }), 'approval required: safety-file:bin/gh');
});
