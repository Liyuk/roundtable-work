import test from 'node:test';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createLedger, issueTotals, loadUsageLedger, recordUsage, recordUsageRow, roleTotals, tokensSince } from '../../runtime/lib/usage-ledger.mjs';

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

test('usage rows persist per issue under state/usage and reload identically from disk', async () => {
  const workRoot = await mkdtemp(join(tmpdir(), 'rt-ledger-'));
  await mkdir(join(workRoot, 'state'));
  const row = { issue: '336', role: 'fixer', harness: 'codex', model: 'm', wallMs: 5, at: 10, usageKnown: true, inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 };
  await recordUsageRow(workRoot, row);
  await recordUsageRow(workRoot, { ...row, usageKnown: false, inputTokens: null, cachedInputTokens: null, outputTokens: null, at: 11 });
  const fresh = await loadUsageLedger(workRoot, '336');
  assert.deepEqual(fresh.rows, [row, { ...row, usageKnown: false, inputTokens: null, cachedInputTokens: null, outputTokens: null, at: 11 }]);
  assert.deepEqual((await loadUsageLedger(workRoot, '999')).rows, []);
  await assert.rejects(loadUsageLedger(workRoot, '../escape'), { code: 'RT_PATH_ESCAPE' });
  await rm(workRoot, { recursive: true, force: true });
});
