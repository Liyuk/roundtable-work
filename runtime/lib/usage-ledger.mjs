import { readFile, writeFile } from 'node:fs/promises';
import { assertSafeId, createConfinement } from './paths.mjs';

// Per-issue and per-role record of every model call. Recording only: totals are read, never gated.
// Pure: rows are plain objects in `ledger.rows`; no clock or network. Persistence (fs) is the thin tail below.

export const createLedger = () => ({ rows: [] });

/** Append one model call: { issue, role, model, inputTokens, outputTokens, wallMs, cost, at }. */
export function recordUsage(ledger, row) {
  ledger.rows.push({ ...row });
}

const totalsOf = (rows) => rows.reduce((sum, r) => ({
  calls: sum.calls + 1,
  inputTokens: sum.inputTokens + r.inputTokens,
  outputTokens: sum.outputTokens + r.outputTokens,
  wallMs: sum.wallMs + r.wallMs,
  cost: sum.cost + r.cost,
}), { calls: 0, inputTokens: 0, outputTokens: 0, wallMs: 0, cost: 0 });

export const issueTotals = (ledger, issue) => totalsOf(ledger.rows.filter((r) => r.issue === issue));

export const roleTotals = (ledger, issue, role) => totalsOf(ledger.rows.filter((r) => r.issue === issue && r.role === role));

/** Input plus output tokens spent on an issue by rows recorded strictly after `afterAt`. */
export const tokensSince = (ledger, { issue, afterAt }) => ledger.rows
  .filter((r) => r.issue === issue && r.at > afterAt)
  .reduce((sum, r) => sum + r.inputTokens + r.outputTokens, 0);

const usagePath = (issue) => `state/usage/${assertSafeId(issue)}.json`;

/** Rows for one issue as persisted; a missing file is an empty ledger. */
export async function loadUsageLedger(workRoot, issue) {
  const confinement = await createConfinement(workRoot);
  const file = await confinement.resolve(usagePath(issue));
  try { return { rows: JSON.parse(await readFile(file, 'utf8')) }; } catch (err) {
    if (err.code === 'ENOENT') return createLedger();
    throw err;
  }
}

/** Append one row to its issue's persisted ledger. */
export async function recordUsageRow(workRoot, row) {
  const confinement = await createConfinement(workRoot);
  const { rows } = await loadUsageLedger(workRoot, row.issue);
  rows.push({ ...row });
  await confinement.withParent(usagePath(row.issue), (dir, base) => writeFile(`${dir}/${base}`, JSON.stringify(rows)), { create: true });
}
