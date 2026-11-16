import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { autonomyTier, loadAutonomy } from '../../runtime/lib/autonomy.mjs';
import { createMergeEntryPoint, ApprovalRequired } from '../../runtime/lib/merge.mjs';
import { mergeRisk } from '../../runtime/lib/merge-risk.mjs';
import { buildPrRecord, upsertPrRecord } from '../../runtime/lib/pr-record.mjs';

// Seams: loadAutonomy({ defaultsPath, hostPath }), autonomyTier(action, autonomy), and createMergeEntryPoint with tierOf.
// Host files live in a temp dir; the real home is never read.
const DEFAULTS = resolve(import.meta.dirname, '../../runtime/defaults/autonomy.json');
const MISSING = '/nonexistent/rt-autonomy-host.json';
const SHIPPED = { kinds: ['merge', 'label', 'comment', 'issue-create', 'issue-close', 'config-change', 'decision'], silentKinds: ['merge'], silentPaths: ['docs/**', 'test/**', 'README.md'], notifyTtlDays: 7, safetyApprover: 'decider' };
const SECRET = 'sk-test-SECRET-380';

async function withHost(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'autonomy-test-'));
  try {
    const hostPath = join(dir, 'autonomy.json');
    if (content !== undefined) await writeFile(hostPath, content);
    return await fn(hostPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadWithHost(host) {
  return withHost(JSON.stringify(host), (hostPath) => loadAutonomy({ defaultsPath: DEFAULTS, hostPath }));
}

const autonomy = () => structuredClone(SHIPPED);

// A green, low-risk, docs-only merge: silent under the shipped defaults.
const silentAction = (over = {}) => ({ kind: 'merge', paths: ['docs/a.md'], labels: [], risk: 'risk:low', ...over });

test('shipped defaults hold the allow-list, and a missing host file means no overrides', async () => {
  const { autonomy: got, ignored } = await loadAutonomy({ defaultsPath: DEFAULTS, hostPath: MISSING });
  assert.deepEqual(got, SHIPPED);
  assert.deepEqual(ignored, []);
});

test('host file may only tighten: lists intersect, TTL takes the minimum, approver moves to owner only', async () => {
  const { autonomy: got, ignored } = await loadWithHost({
    kinds: ['merge', 'label', 'release'],
    silentKinds: ['merge', 'comment'],
    silentPaths: ['docs/**', 'secrets/**'],
    notifyTtlDays: 3,
    safetyApprover: 'owner',
  });
  assert.deepEqual(got, { ...SHIPPED, kinds: ['merge', 'label'], silentKinds: ['merge'], silentPaths: ['docs/**'], notifyTtlDays: 3, safetyApprover: 'owner' });
  assert.deepEqual(ignored, ['kinds:release', 'silentKinds:comment', 'silentPaths:secrets/**']);
});

test('loosening host values are ignored and reported', async () => {
  const { autonomy: got, ignored } = await loadWithHost({ notifyTtlDays: 30, safetyApprover: 'anyone' });
  assert.equal(got.notifyTtlDays, 7);
  assert.equal(got.safetyApprover, 'decider');
  assert.deepEqual(ignored, ['safetyApprover']);
});

test('invalid JSON and wrong types throw an error naming the file or key, never file content', async () => {
  await withHost(`{ "kinds": "${SECRET}"`, async (hostPath) => {
    await assert.rejects(loadAutonomy({ defaultsPath: DEFAULTS, hostPath }), (err) => err.message.includes(hostPath) && !err.message.includes(SECRET));
  });
  await assert.rejects(loadWithHost({ kinds: SECRET }), (err) => err.message.includes('kinds') && !err.message.includes(SECRET));
  await assert.rejects(loadWithHost({ notifyTtlDays: '7' }), /notifyTtlDays/);
});

test('rule 1: a kind outside the allow-list is approve-first', () => {
  assert.deepEqual(autonomyTier(silentAction({ kind: 'release' }), autonomy()), { tier: 'approve-first', reasons: ['kind-not-allowed'] });
});

test('rule 2: closed categories and production rules are approve-first', () => {
  assert.deepEqual(autonomyTier(silentAction({ category: 'credentials' }), autonomy()), { tier: 'approve-first', reasons: ['closed-category:credentials'] });
  assert.deepEqual(autonomyTier(silentAction({ production: 'label:deploy' }), autonomy()), { tier: 'approve-first', reasons: ['production:label:deploy'] });
});

test('rule 3: an irreversible action is approve-first', () => {
  assert.deepEqual(autonomyTier(silentAction({ revert: false }), autonomy()), { tier: 'approve-first', reasons: ['irreversible'] });
});

test('rule 4: every safety file is a reason and the approver is the configured one', () => {
  const paths = ['docs/a.md', '.github/workflows/check.yml', 'bin/gh'];
  assert.deepEqual(autonomyTier(silentAction({ paths }), autonomy()), { tier: 'approve-first', reasons: ['safety-file:.github/workflows/check.yml', 'safety-file:bin/gh'], approver: 'decider' });
  assert.equal(autonomyTier(silentAction({ paths }), { ...autonomy(), safetyApprover: 'owner' }).approver, 'owner');
});

test('rule 5: the owner override label is approve-first', () => {
  assert.deepEqual(autonomyTier(silentAction({ labels: ['rt:tier-approve'] }), autonomy()), { tier: 'approve-first', reasons: ['owner-override'] });
});

test('rule 6: high risk is approve-first', () => {
  assert.deepEqual(autonomyTier(silentAction({ risk: 'risk:high' }), autonomy()), { tier: 'approve-first', reasons: ['risk-high'] });
});

test('rule 7: silent needs a silent kind, low risk, and every path matched by a silent glob', () => {
  assert.deepEqual(autonomyTier(silentAction(), autonomy()), { tier: 'auto-silent', reasons: [] });
  assert.deepEqual(autonomyTier(silentAction({ paths: ['test/runtime/x/y.test.mjs', 'README.md'] }), autonomy()), { tier: 'auto-silent', reasons: [] });
  assert.equal(autonomyTier(silentAction({ paths: ['docs/a.md', 'runtime/lib/x.mjs'] }), autonomy()).tier, 'auto-notify');
  assert.equal(autonomyTier(silentAction({ paths: ['docs-old/a.md'] }), autonomy()).tier, 'auto-notify');
  assert.equal(autonomyTier(silentAction({ risk: 'risk:medium' }), autonomy()).tier, 'auto-notify');
  assert.equal(autonomyTier(silentAction({ paths: [] }), autonomy()).tier, 'auto-notify');
  assert.equal(autonomyTier(silentAction({ kind: 'comment' }), autonomy()).tier, 'auto-notify');
});

test('rule 8: anything else is auto-notify', () => {
  assert.deepEqual(autonomyTier(silentAction({ paths: ['runtime/lib/x.mjs'] }), autonomy()), { tier: 'auto-notify', reasons: [] });
});

test('precedence: earlier rules win over later ones', () => {
  const a = autonomy();
  assert.deepEqual(autonomyTier(silentAction({ kind: 'release', category: 'scope' }), a).reasons, ['kind-not-allowed']);
  assert.deepEqual(autonomyTier(silentAction({ category: 'scope', production: 'label:live' }), a).reasons, ['closed-category:scope']);
  assert.deepEqual(autonomyTier(silentAction({ production: 'label:live', revert: false }), a).reasons, ['production:label:live']);
  assert.deepEqual(autonomyTier(silentAction({ revert: false, paths: ['bin/gh'] }), a).reasons, ['irreversible']);
  assert.deepEqual(autonomyTier(silentAction({ paths: ['bin/gh'], labels: ['rt:tier-approve'] }), a).reasons, ['safety-file:bin/gh']);
  assert.deepEqual(autonomyTier(silentAction({ labels: ['rt:tier-approve'], risk: 'risk:high' }), a).reasons, ['owner-override']);
});

test('pinned: a docs-only green PR is auto-silent', () => {
  const action = { kind: 'merge', paths: ['docs/a.md'], labels: [], risk: mergeRisk({ paths: ['docs/a.md'], changedLines: 10, ci: 'green' }).label };
  assert.equal(autonomyTier(action, autonomy()).tier, 'auto-silent');
});

test('pinned: 500 changed runtime lines are risk:medium and auto-notify', () => {
  const risk = mergeRisk({ paths: ['runtime/lib/x.mjs'], changedLines: 500, ci: 'green' }).label;
  assert.equal(risk, 'risk:medium');
  assert.deepEqual(autonomyTier({ kind: 'merge', paths: ['runtime/lib/x.mjs'], labels: [], risk }, autonomy()), { tier: 'auto-notify', reasons: [] });
});

test('pinned: any workflow path is approve-first whatever the labels or the host file', async () => {
  const { autonomy: host } = await loadWithHost({ kinds: ['merge'], silentPaths: ['**'], safetyApprover: 'owner' });
  const action = { kind: 'merge', paths: ['.github/workflows/ci.yml'], labels: ['rt:tier-approve'], risk: 'risk:low' };
  assert.equal(autonomyTier(action, host).tier, 'approve-first');
  assert.equal(autonomyTier({ ...action, labels: [] }, autonomy()).tier, 'approve-first');
});

test('pinned: a revert of a silent-looking action is auto-notify, never auto-silent', () => {
  assert.deepEqual(autonomyTier(silentAction({ revertOf: 'merge:abc1234' }), autonomy()), { tier: 'auto-notify', reasons: [] });
});

test('pinned: revert false is approve-first irreversible', () => {
  assert.deepEqual(autonomyTier(silentAction({ revert: false }), autonomy()), { tier: 'approve-first', reasons: ['irreversible'] });
});

// Merge entry point with tierOf: same fake GitHub shape as test/runtime/gates.test.mjs.
const RECORD_BODY = upsertPrRecord('', buildPrRecord({ issue: '380', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'] }));
function livePullRequest(files) {
  return { state: 'open', draft: false, head: 'abc1234', mergeable: true, files, body: RECORD_BODY };
}

function mergeFixture({ tierOf, files = ['runtime/lib/x.mjs'], persisted } = {}) {
  const calls = [];
  const entry = createMergeEntryPoint({ mode: 'agent',
    gateState: { async get() { return persisted ?? { issue: '380', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'], safetyFiles: [], safetyApproved: false }; } },
    github: {
      async getPullRequest() { calls.push('pr'); return livePullRequest(files); },
      async requiredGreen() { calls.push('ci'); return true; },
      async squashMerge(_pr, options) { calls.push(['merge', options]); return 'merged'; },
    },
    tierOf,
  });
  const evidence = { issue: '380', head: 'abc1234', tree: 'tree-a', highRisk: false, passed: ['gate0', 'gate1', 'ci'], ciGreen: true };
  return { entry, calls, evidence };
}

test('merge with tierOf: approve-first throws ApprovalRequired and never squashes', async () => {
  const f = mergeFixture({ tierOf: () => ({ tier: 'approve-first', reasons: ['risk-high'] }) });
  await assert.rejects(f.entry(90, f.evidence), (err) => err instanceof ApprovalRequired && err.name === 'ApprovalRequired' && err.code === 'APPROVAL_REQUIRED' && err.message.includes('risk-high'));
  assert.equal(f.calls.some(Array.isArray), false);
});

test('merge with tierOf: auto-notify merges and returns tier, reasons, and the squash result', async () => {
  const f = mergeFixture({ tierOf: (evidence, live) => { assert.equal(evidence.head, 'abc1234'); assert.deepEqual(live.files, ['runtime/lib/x.mjs']); return { tier: 'auto-notify', reasons: [] }; } });
  assert.deepEqual(await f.entry(90, f.evidence), { tier: 'auto-notify', reasons: [], result: 'merged' });
  assert.equal(f.calls.filter(Array.isArray).length, 1);
});

test('merge without tierOf returns the squash result unchanged', async () => {
  const f = mergeFixture();
  assert.equal(await f.entry(90, f.evidence), 'merged');
});

test('merge with tierOf still requires safety-file approval even when auto-notify', async () => {
  const f = mergeFixture({
    files: ['.github/workflows/check.yml'],
    persisted: { issue: '380', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'gate2', 'ci'], safetyFiles: ['.github/workflows/check.yml'], safetyApproved: false },
    tierOf: () => ({ tier: 'auto-notify', reasons: [] }),
  });
  await assert.rejects(f.entry(90, f.evidence), /Safety-file approval is missing/);
  assert.equal(f.calls.some(Array.isArray), false);
});
