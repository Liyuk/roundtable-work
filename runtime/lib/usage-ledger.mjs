// Per-issue and per-role record of every model call. Recording only: totals are read, never gated.
// Pure: rows are plain objects in `ledger.rows`; no fs, clock or network.

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
