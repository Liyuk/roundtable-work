import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchAsk, makeDispatchLine } from '../../runtime/lib/daemon-cards.mjs';
import { askHash } from '../../runtime/lib/daemon-asks.mjs';
import { cycleSteps } from '../../runtime/lib/daemon-loop.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { openActionJournal, ACTIONS_PATH } from '../../runtime/lib/action-journal.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';
import { loadAutonomy } from '../../runtime/lib/autonomy.mjs';
import { deriveLabelState } from '../../runtime/lib/label-projection.mjs';
import { readLine, routeCard, startLine } from '../../runtime/lib/decision-cards.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const NAME_QUESTION = 'Which name?';
const NAME = { category: 'naming', question: NAME_QUESTION, evidence: ['docs/b.md'], options: ['A', 'B'], recommendation: 'A' };
const failing = { decide: async () => { throw new Error('no provider in test'); } };

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'daemon-asks-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

// The policy the daemon builds: defaults autonomy (no host file), the action journal and the intervention ledger.
const policyFor = async (root) => ({
  autonomy: (await loadAutonomy({ hostPath: join(root, 'no-host.json') })).autonomy,
  journal: openActionJournal(root, { git: {}, github: {} }),
  ledger: openInterventions(root),
});

const records = (root) => readFileSync(join(root, ACTIONS_PATH), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ciEvent = (id, issue) => ({ source_event_id: id, kind: 'ci', issue, payload: {}, receivedAt: T0 });

test('A1: the card carries the Chief options and recommendation, and scopeKind stays out of the routed card', async () => {
  await withRoot(async (root) => {
    const seen = [];
    const recorder = { decide: async ({ card }) => { seen.push(card); return { choice: 'keep', reason: 'chief', source: 'rule' }; } };
    await startLine({ root, issue: 11, sessionId: 's-11' });
    await dispatchAsk({ root, issue: 11, category: 'naming', question: 'Keep or drop?', evidence: ['docs/a.md'], options: ['keep', 'drop'], recommendation: 'drop', scopeKind: 'none', provider: recorder });
    assert.deepEqual(seen[0].options, ['keep', 'drop']);
    assert.equal(seen[0].recommendation, 'drop');
    assert.equal('scopeKind' in seen[0], false);
  });
});

test('A1: without options the card keeps approve and reject with recommendation reject', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 11, sessionId: 's-11' });
    await dispatchAsk({ root, issue: 11, category: 'destructive', question: 'Delete?', evidence: ['docs/a.md'], provider: failing });
    const pending = (await readLine(root, 11)).pending;
    assert.deepEqual(pending.options, ['approve', 'reject']);
    assert.equal(pending.recommendation, 'reject');
  });
});

test('A1: scopeKind from the decision reaches the policy', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    await dispatchAsk({ root, issue: 12, ...NAME, scopeKind: 'criterion-unreliable', provider: failing, policy: await policyFor(root) });
    const [decision] = (await readLine(root, 12)).decisions;
    assert.equal(decision.choice, 'A');
    assert.equal(decision.source, 'policy');
    assert.equal(decision.reason, 'criterion-unreliable');
  });
});

test('A2: a resolved ask runs through the journal, records the decision on the line, and the line continues', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    const policy = await policyFor(root);
    const result = await dispatchAsk({ root, issue: 12, ...NAME, provider: failing, policy });
    const id = `act:decision:12:${askHash(NAME_QUESTION)}`;
    assert.deepEqual(result, { status: 'resolved' });
    assert.equal(policy.journal.state(id), 'executed_pending_confirmation');
    const line = await readLine(root, 12);
    assert.equal(line.status, 'running');
    assert.equal(line.pending, null);
    assert.deepEqual(line.decisions.map((d) => [d.choice, d.source]), [['A', 'policy']]);
    const notices = openOutbox(root).items().filter((item) => item.id.startsWith('notice:action:'));
    assert.deepEqual(notices.map((n) => n.id), [`notice:action:${id}:executed_pending_confirmation`]);
    assert.equal(notices[0].payload.actionId, id);
  });
});

test('A3: rollback restores the line to the suspended ask it resolved', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    await routeCard({ root, card: { issue: 12, ...NAME }, provider: failing });
    const policy = await policyFor(root);
    await dispatchAsk({ root, issue: 12, ...NAME, provider: failing, policy });
    const id = `act:decision:12:${askHash(NAME_QUESTION)}`;
    assert.equal((await readLine(root, 12)).status, 'running');
    assert.deepEqual(policy.journal.list().find((rec) => rec.id === id).revert.map((s) => s.step), ['file-restore']);
    assert.equal((await policy.journal.rollback(id, { notify: () => {} })).state, 'rolled_back');
    const line = await readLine(root, 12);
    assert.equal(line.status, 'suspended');
    assert.equal(line.pending.question, NAME_QUESTION);
  });
});

test('A4: a block suspends only its line; a closed-category tier (approve-first) goes to routeCard; another line still runs', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 11, sessionId: 's-11' });
    await startLine({ root, issue: 12, sessionId: 's-12' });
    await startLine({ root, issue: 13, sessionId: 's-13' });
    const policy = await policyFor(root);
    const decisionOf = (issue) => ({
      11: { category: 'credentials', question: 'Token?', evidence: ['docs/a.md'] },
      12: NAME,
      13: { category: 'scope', question: 'Widen scope?', evidence: ['docs/c.md'], options: ['A', 'B'], recommendation: 'A' },
    }[issue]);
    const inbox = openInbox(root);
    for (const issue of [11, 12, 13]) inbox.accept(ciEvent(`ci-${issue}`, issue));
    await cycleSteps({ root, inbox, timers: openTimers(root), now: T0, dispatchLine: makeDispatchLine({ root, decisionOf, provider: failing, policy }) });
    assert.equal((await readLine(root, 11)).status, 'suspended');
    assert.equal((await readLine(root, 13)).status, 'suspended');
    assert.equal((await readLine(root, 12)).status, 'running');
    assert.equal((await readLine(root, 12)).decisions[0].source, 'policy');
  });
});

test('A5: each resolved ask appends one self decision entry, and a replay performs nothing a second time', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    const policy = await policyFor(root);
    await dispatchAsk({ root, issue: 12, ...NAME, provider: failing, policy });
    await dispatchAsk({ root, issue: 12, ...NAME, provider: failing, policy });
    const entries = openInterventions(root).entries().entries;
    assert.deepEqual(entries.map((e) => [e.category, e.source, e.ref]), [['decision', 'self', '#12']]);
    assert.equal(records(root).filter((rec) => rec.type === 'action').length, 1);
    assert.equal((await readLine(root, 12)).decisions.length, 1);
    assert.equal(openOutbox(root).items().filter((item) => item.id.startsWith('notice:action:')).length, 1);
  });
});

test('A6: a resolved ask is never projected as rt:ask', () => {
  // The daemon never sets `state.pause` for a resolved ask, so the projection keeps the line running.
  const labels = deriveLabelState({ issue: { state: 'open', labels: [] }, state: { status: 'running' } });
  assert.equal(labels.includes('rt:ask'), false);
});
