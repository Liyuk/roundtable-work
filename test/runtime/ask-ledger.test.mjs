import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchAsk } from '../../runtime/lib/daemon-cards.mjs';
import { askHash } from '../../runtime/lib/daemon-asks.mjs';
import { sweepAskTimeouts, ASK_TIMEOUT_MS } from '../../runtime/lib/ask-timeout.mjs';
import { recordAsk, ASK_LEDGER_PATH } from '../../runtime/lib/ask-ledger.mjs';
import { computeMetrics } from '../../runtime/lib/metrics.mjs';
import { openActionJournal } from '../../runtime/lib/action-journal.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';
import { loadAutonomy } from '../../runtime/lib/autonomy.mjs';
import { startLine } from '../../runtime/lib/decision-cards.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const at = (ms) => () => ms;
const QUESTION = 'Which name?';
const NAMING = { category: 'naming', question: QUESTION, evidence: ['docs/b.md'], options: ['A', 'B'], recommendation: 'A' };
const CREDENTIALS = { ...NAMING, category: 'credentials' };
const failing = { decide: async () => { throw new Error('no provider in test'); } };
const KEY = askHash(QUESTION);

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'ask-ledger-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const policyFor = async (root) => ({
  autonomy: (await loadAutonomy({ hostPath: join(root, 'no-host.json') })).autonomy,
  journal: openActionJournal(root, { git: {}, github: {} }),
  ledger: openInterventions(root),
});

const ledgerOf = (root) => readFileSync(join(root, ASK_LEDGER_PATH), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Counts asks for the single fixture window, from the ledger file.
const metricsOf = (root) => computeMetrics({ since: T0, until: Date.now() + ASK_TIMEOUT_MS, asks: ledgerOf(root) }).total.asks;

test('recordAsk appends one line per (route, issue, key), without the question text', async () => {
  await withRoot(async (root) => {
    recordAsk(root, { issue: 12, key: KEY, route: 'owner', at: T0 });
    recordAsk(root, { issue: 12, key: KEY, route: 'owner', at: T0 + 1 });
    recordAsk(root, { issue: 12, key: KEY, route: 'supervisor', at: T0 + 2 });
    assert.deepEqual(ledgerOf(root), [
      { issue: 12, key: KEY, route: 'owner', at: T0 },
      { issue: 12, key: KEY, route: 'supervisor', at: T0 + 2 },
    ]);
    assert.ok(!readFileSync(join(root, ASK_LEDGER_PATH), 'utf8').includes(QUESTION));
  });
});

test('an ask resolved by the supervisor policy counts only as supervisor-held', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    const result = await dispatchAsk({ root, issue: 12, ...NAMING, provider: failing, policy: await policyFor(root), now: at(T0) });
    assert.deepEqual(result, { status: 'resolved' });
    assert.deepEqual(ledgerOf(root).map(({ issue, key, route }) => [issue, key, route]), [[12, KEY, 'supervisor']]);
    assert.deepEqual(metricsOf(root), { supervisorHeld: 1, ownerInterruptions: 0 });
  });
});

test('an ask blocked to the owner counts only as an owner interruption', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    const result = await dispatchAsk({ root, issue: 12, ...CREDENTIALS, provider: failing, policy: await policyFor(root), now: at(T0) });
    assert.deepEqual(result, { status: 'suspended' });
    assert.deepEqual(ledgerOf(root), [{ issue: 12, key: KEY, route: 'owner', at: T0 }]);
    assert.deepEqual(metricsOf(root), { supervisorHeld: 0, ownerInterruptions: 1 });
  });
});

test('an ask routed to the owner and later resolved by the supervisor timeout counts only as supervisor-held', async () => {
  await withRoot(async (root) => {
    await startLine({ root, issue: 12, sessionId: 's-12' });
    await dispatchAsk({ root, issue: 12, ...NAMING, provider: failing, now: at(T0) });
    assert.deepEqual(metricsOf(root), { supervisorHeld: 0, ownerInterruptions: 1 });

    const policy = await policyFor(root);
    await sweepAskTimeouts({ root, policy, now: at(T0 + ASK_TIMEOUT_MS) });
    assert.deepEqual(ledgerOf(root).map((r) => r.route), ['owner', 'supervisor']);
    assert.deepEqual(metricsOf(root), { supervisorHeld: 1, ownerInterruptions: 0 });
  });
});
