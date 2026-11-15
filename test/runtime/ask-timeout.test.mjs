import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchAsk, makeDispatchLine } from '../../runtime/lib/daemon-cards.mjs';
import { askHash } from '../../runtime/lib/daemon-asks.mjs';
import { confirmStandingRule, sweepAskTimeouts, standingKind } from '../../runtime/lib/ask-timeout.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { openActionJournal } from '../../runtime/lib/action-journal.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';
import { loadAutonomy } from '../../runtime/lib/autonomy.mjs';
import { readLine, startLine } from '../../runtime/lib/decision-cards.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (ms) => () => ms;
const NAME_QUESTION = 'Which name?';
const NAME = { category: 'naming', question: NAME_QUESTION, evidence: ['docs/b.md'], options: ['A', 'B'], recommendation: 'A' };
const DIRECTION = { category: 'direction', question: NAME_QUESTION, evidence: ['docs/b.md'], options: ['A', 'B'], recommendation: 'A' };
const failing = { decide: async () => { throw new Error('no provider in test'); } };

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'ask-timeout-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const policyFor = async (root) => ({
  autonomy: (await loadAutonomy({ hostPath: join(root, 'no-host.json') })).autonomy,
  journal: openActionJournal(root, { git: {}, github: {} }),
  ledger: openInterventions(root),
});

// Suspends issue `issue` with a card that no policy has seen: the line waits for an owner decision.
const suspend = (root, issue, card, now = T0) => {
  return startLine({ root, issue, sessionId: `s-${issue}` }).then(() => dispatchAsk({ root, issue, ...card, provider: failing, now: at(now) }));
};

test('1: a resolvable ask produces no approval-request outbox item', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    const result = await dispatchAsk({ root, issue: 12, ...NAME, provider: failing, policy: await policyFor(root) });
    assert.deepEqual(result, { status: 'resolved' });
    assert.equal(openOutbox(root).items().filter((i) => i.payload?.subtype === 'approval-request').length, 0);
  });
});

test('1: a blocked ask is still routed and notifies the owner once', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    const card = { ...NAME, category: 'credentials' };
    assert.deepEqual(await dispatchAsk({ root, issue: 12, ...card, provider: failing, policy: await policyFor(root) }), { status: 'suspended' });
    assert.equal(openOutbox(root).items().filter((i) => i.payload?.subtype === 'approval-request').length, 1);
  });
});

test('2: a reversible suspended ask past the 24 h timeout runs its recommendation, with a journal rollback and a self entry', async () => {
  await withRoot(async (root) => {
    await suspend(root, 12, DIRECTION);
    const policy = await policyFor(root);
    await sweepAskTimeouts({ root, policy, now: at(T0 + DAY - 1) });
    assert.equal((await readLine(root, 12)).status, 'suspended');

    await sweepAskTimeouts({ root, policy, now: at(T0 + DAY) });
    const line = await readLine(root, 12);
    assert.equal(line.status, 'running');
    assert.deepEqual(line.decisions.map((d) => [d.choice, d.source]), [['A', 'timeout-default']]);

    const id = `act:decision:12:${askHash(NAME_QUESTION)}`;
    assert.equal(policy.journal.state(id), 'executed_pending_confirmation');
    assert.equal(policy.journal.list().find((rec) => rec.id === id).revert.at(0).step, 'file-restore');
    assert.deepEqual(policy.ledger.entries().entries.map((e) => [e.category, e.source, e.ref]), [['decision', 'self', '#12']]);

    assert.equal((await policy.journal.rollback(id, { notify: () => {} })).state, 'rolled_back');
    const restored = await readLine(root, 12);
    assert.equal(restored.status, 'suspended');
    assert.equal(restored.pending.question, NAME_QUESTION);
  });
});

test('2: re-dispatching the same unresolved ask does not restart its timeout clock', async () => {
  await withRoot(async (root) => {
    await suspend(root, 12, DIRECTION);
    await dispatchAsk({ root, issue: 12, ...DIRECTION, provider: failing, now: at(T0 + DAY - 60_000) });
    await sweepAskTimeouts({ root, policy: await policyFor(root), now: at(T0 + DAY) });
    assert.equal((await readLine(root, 12)).decisions[0].source, 'timeout-default');
  });
});

test('2: the sweep does not re-execute a rolled-back ask on the next cycle', async () => {
  await withRoot(async (root) => {
    await suspend(root, 12, DIRECTION);
    const policy = await policyFor(root);
    await sweepAskTimeouts({ root, policy, now: at(T0 + DAY) });
    await policy.journal.rollback(`act:decision:12:${askHash(NAME_QUESTION)}`, { notify: () => {} });
    await sweepAskTimeouts({ root, policy, now: at(T0 + 2 * DAY) });
    assert.equal((await readLine(root, 12)).status, 'suspended');
    assert.equal(policy.journal.list().length, 1);
  });
});

test('3: red-line categories and goal changes stay suspended however old', async () => {
  await withRoot(async (root) => {
    const cards = {
      13: { ...DIRECTION, category: 'credentials' },
      14: { ...DIRECTION, category: 'destructive' },
      15: { ...DIRECTION, category: 'production' },
      16: { ...DIRECTION, category: 'scope' },
      17: { ...DIRECTION, scopeKind: 'scope-change' },
    };
    for (const [issue, card] of Object.entries(cards)) await suspend(root, Number(issue), card);
    const policy = await policyFor(root);
    await sweepAskTimeouts({ root, policy, now: at(T0 + 100 * DAY) });
    for (const issue of Object.keys(cards)) assert.equal((await readLine(root, Number(issue))).status, 'suspended', `#${issue}`);
    assert.equal(policy.journal.list().length, 0);
  });
});

test('3: a goal change with a valid recommendation is routed to the card, never resolved by policy', async () => {
  await withRoot(async (root) => {
    const policy = await policyFor(root);
    for (const [issue, card] of [[18, { ...NAME, scopeKind: 'scope-change' }], [19, { ...NAME, category: 'scope' }]]) {
      await startLine({ root, issue, sessionId: `s-${issue}` });
      assert.deepEqual(await dispatchAsk({ root, issue, ...card, provider: failing, policy }), { status: 'suspended' });
      assert.equal((await readLine(root, issue)).status, 'suspended');
      assert.deepEqual((await readLine(root, issue)).decisions, []);
    }
    assert.equal(policy.journal.list().length, 0);
    assert.equal(policy.ledger.entries().entries.filter((e) => e.source === 'self').length, 0);
  });
});

test('4: a standing-rule proposal is written after 3 owner answers and is inactive until confirmed', async () => {
  await withRoot(async (root) => {
    const dispatch = makeDispatchLine({ root, owner: 'owner', decisionOf: () => undefined });
    for (const issue of [21, 22, 23]) {
      await suspend(root, issue, DIRECTION);
      await dispatch({ issue, events: [{ kind: 'owner_comment', issue, payload: { decision: 'approve', author: 'owner' } }] });
      assert.equal((await readLine(root, issue)).status, 'running');
    }
    const kind = standingKind(DIRECTION.category, NAME_QUESTION);
    const file = join(root, '.roundtable/state/standing-rules.json');
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[kind].status, 'proposed');

    // Not active before confirmation: a new same-kind ask is not decided by the proposal, and the timeout is the only default.
    await suspend(root, 24, DIRECTION, T0);
    await sweepAskTimeouts({ root, policy: await policyFor(root), now: at(T0 + DAY - 1) });
    assert.equal((await readLine(root, 24)).status, 'suspended');

    confirmStandingRule({ root, kind, owner: 'owner' });
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[kind].status, 'confirmed');
  });
});
