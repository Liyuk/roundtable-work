import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, issueTotals, recordUsage, roleTotals, tokensSince } from '../../runtime/lib/usage-ledger.mjs';

test('per-issue and per-role totals equal the sum of recorded rows', () => {
  const ledger = createLedger();
  recordUsage(ledger, { issue: 218, role: 'fixer', model: 'a', inputTokens: 10, outputTokens: 2, wallMs: 5, cost: 0.1, at: 1 });
  recordUsage(ledger, { issue: 218, role: 'chief', model: 'b', inputTokens: 20, outputTokens: 3, wallMs: 7, cost: 0.2, at: 2 });
  recordUsage(ledger, { issue: 219, role: 'fixer', model: 'a', inputTokens: 99, outputTokens: 0, wallMs: 1, cost: 1, at: 3 });
  const issue = { calls: 2, inputTokens: 30, outputTokens: 5, wallMs: 12, cost: 0.30000000000000004 };
  assert.deepEqual(issueTotals(ledger, 218), issue);
  assert.deepEqual(roleTotals(ledger, 218, 'fixer'), { calls: 1, inputTokens: 10, outputTokens: 2, wallMs: 5, cost: 0.1 });
  assert.equal(tokensSince(ledger, { issue: 218, afterAt: 1 }), 23);
  assert.equal(tokensSince(ledger, { issue: 218, afterAt: -Infinity }), 35);
});
