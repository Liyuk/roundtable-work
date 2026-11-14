const TOKENS = ['APPROVE-MERGE', 'REJECT-MERGE'];
const REMINDER = '\n\nFormat: answer with a line containing exactly one of APPROVE-MERGE or REJECT-MERGE.';

/** Return the single decision token in the answer, or null when it has none or both. */
export function parseMergeDecision(text) {
  const found = TOKENS.filter(token => new RegExp(`(?<![\\w-])${token}(?![\\w-])`).test(text));
  return found.length === 1 ? found[0] : null;
}

/** Ask for a safety-merge decision; one format re-ask is free, the first ask spends the budget. */
export async function requestMergeDecision({ ask, prompt, budget }) {
  if (budget.used >= budget.max) throw new Error('decision budget exhausted');
  budget.used += 1;
  const verdict = parseMergeDecision(await ask(prompt));
  if (verdict) return { verdict, reasked: false };
  return { verdict: parseMergeDecision(await ask(`${prompt}${REMINDER}`)), reasked: true };
}
