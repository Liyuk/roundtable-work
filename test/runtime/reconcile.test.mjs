import test from 'node:test';
import assert from 'node:assert/strict';
import { actionKey, reconcile } from '../../runtime/lib/reconcile.mjs';

// Synthetic facts only. Each table case rebuilds the situation from scratch and names the expected action literally.
const HOUR = 3600000;
const NOW = 1000 * HOUR;
const issue = (over) => ({ number: 1001, state: 'open', needsPr: false, verifiedComplete: false, ...over });
const pr = (over) => ({ number: 2001, head: 'h1', merged: false, mergeReady: false, ...over });
const main = (over) => ({ head: 'm1', ciStatus: 'green', rerunAttempts: 0, ...over });
const local = (over) => ({ now: NOW, doneKeys: [], terminalAt: undefined, ...over });

const CASES = [
  { name: '#440 PR merged, issue open after verified completion', issue: issue({ verifiedComplete: true, needsPr: true }), pr: pr({ merged: true }), action: 'close' },
  { name: '#504 verified completion, no PR needed, issue open', issue: issue({ verifiedComplete: true }), pr: null, action: 'close' },
  { name: '#207 wake-budget block, first, 6h elapsed', issue: issue({ blocked: { cause: 'wake-budget', at: NOW - 6 * HOUR, autoRetries: 0 } }), pr: null, action: 'retry-blocked' },
  { name: '#207 wake-budget block, first, 5h elapsed', issue: issue({ blocked: { cause: 'wake-budget', at: NOW - 5 * HOUR, autoRetries: 0 } }), pr: null, action: 'wait' },
  { name: '#232 non-red-line ask older than 24h with recommendation', issue: issue({ ask: { category: 'scope-tuning', recommendation: 'option-b', openedAt: NOW - 25 * HOUR } }), pr: null, action: 'default-answer' },
  { name: '#322 red-line credentials ask older than 24h', issue: issue({ ask: { category: 'credentials', recommendation: 'rotate', openedAt: NOW - 30 * HOUR } }), pr: null, action: 'wait' },
  { name: '#334 red-line destructive ask older than 24h', issue: issue({ ask: { category: 'destructive', recommendation: 'delete', openedAt: NOW - 30 * HOUR } }), pr: null, action: 'wait' },
  { name: '#340 red-line scope ask older than 24h', issue: issue({ ask: { category: 'scope', recommendation: 'widen', openedAt: NOW - 30 * HOUR } }), pr: null, action: 'wait' },
  { name: 'production red-line ask older than 24h', issue: issue({ ask: { category: 'production', recommendation: 'ship', openedAt: NOW - 30 * HOUR } }), pr: null, action: 'wait' },
  { name: 'second block after auto-retry (digest, not owner wait)', issue: issue({ blocked: { cause: 'no-progress', at: NOW - 7 * HOUR, autoRetries: 1 } }), pr: null, action: 'wait' },
  { name: 'PR approved and checks green', issue: issue(), pr: pr({ mergeReady: true }), action: 'merge' },
  { name: 'main CI red at head, first attempt', issue: issue(), pr: null, main: main({ ciStatus: 'red' }), action: 'rerun-main-once' },
  { name: 'owner comment newer than terminal status', issue: issue({ ownerCommentAt: NOW - HOUR }), pr: null, local: local({ terminalAt: NOW - 2 * HOUR }), action: 'resume' },
];

for (const c of CASES) {
  test(`reconcile: ${c.name} -> ${c.action}`, () => {
    const result = reconcile(c.issue, c.pr ?? null, c.main ?? main(), c.local ?? local());
    assert.equal(result.action, c.action);
    assert.equal(typeof result.reason, 'string');
  });
}

test('red-line ask older than 24h stays suspended and never becomes default-answer', () => {
  const red = issue({ ask: { category: 'credentials', recommendation: 'rotate', openedAt: NOW - 100 * HOUR } });
  const result = reconcile(red, null, main(), local());
  assert.equal(result.action, 'wait');
  assert.equal(result.ledger, null);
});

test('non-red-line ask under 24h waits for the timeout', () => {
  const young = issue({ ask: { category: 'scope-tuning', recommendation: 'option-b', openedAt: NOW - 23 * HOUR } });
  assert.equal(reconcile(young, null, main(), local()).action, 'wait');
});

test('each automatic action yields exactly one self ledger descriptor', () => {
  const cases = [
    [issue({ verifiedComplete: true }), null, main(), local(), 'close'],
    [issue(), pr({ mergeReady: true }), main(), local(), 'merge'],
    [issue({ ask: { category: 'scope-tuning', recommendation: 'b', openedAt: NOW - 25 * HOUR } }), null, main(), local(), 'default-answer'],
    [issue({ blocked: { cause: 'worker-crash', at: NOW - 6 * HOUR, autoRetries: 0 } }), null, main(), local(), 'retry-blocked'],
    [issue(), null, main({ ciStatus: 'red' }), local(), 'rerun-main-once'],
  ];
  for (const [i, p, m, l, action] of cases) {
    const result = reconcile(i, p, m, l);
    assert.equal(result.action, action);
    assert.deepEqual(result.ledger, { kind: 'self', issue: 1001, head: p?.head ?? m.head, action, key: actionKey(1001, p?.head ?? m.head, action) });
  }
});

test('wait and resume yield no ledger descriptor', () => {
  assert.equal(reconcile(issue(), null, main(), local()).ledger, null);
  const resume = reconcile(issue({ ownerCommentAt: NOW - HOUR }), null, main(), local({ terminalAt: NOW - 2 * HOUR }));
  assert.equal(resume.action, 'resume');
  assert.equal(resume.ledger, null);
});

test('idempotency: the same (issue, head, action) already recorded gives no second action', () => {
  const key = actionKey(1001, 'h1', 'merge');
  const result = reconcile(issue(), pr({ mergeReady: true }), main(), local({ doneKeys: [key] }));
  assert.equal(result.action, 'wait');
  assert.equal(result.ledger, null);
  assert.match(result.reason, /already done/);
});

test('idempotency key is scoped to head: a new head may act again', () => {
  const key = actionKey(1001, 'h0', 'merge');
  assert.equal(reconcile(issue(), pr({ mergeReady: true }), main(), local({ doneKeys: [key] })).action, 'merge');
});
