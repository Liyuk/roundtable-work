// Pure terminal-state reconciler: one call returns exactly one action for a line. Facts are GitHub API data (untrusted
// input shapes, not validated here). Clock is `localStatus.now`; nothing touches network, gh, or fs.
// Automatic actions (close, merge, default-answer, retry-blocked, rerun-main-once) carry one `self` ledger descriptor;
// the caller writes it. Each action key is (issue, head, action); keys already in `localStatus.doneKeys` yield wait.
export const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const BLOCK_RETRY_MS = 6 * 60 * 60 * 1000;
const RED_LINE = new Set(['credentials', 'destructive', 'production', 'scope']);
const RETRY_CAUSES = new Set(['wake-budget', 'no-progress', 'worker-crash']);
const SELF_ACTIONS = new Set(['close', 'merge', 'default-answer', 'retry-blocked', 'rerun-main-once']);

export const actionKey = (issue, head, action) => `${issue}:${head}:${action}`;
const result = (action, reason) => ({ action, reason });

function candidate(issue, pr, main, { now, terminalAt }) {
  if (issue.ownerCommentAt > terminalAt) return result('resume', 'owner comment newer than terminal status');
  if (issue.state === 'open' && issue.verifiedComplete && (!issue.needsPr || pr?.merged)) return result('close', 'verified completion');
  if (pr && !pr.merged && pr.mergeReady) return result('merge', 'PR approved and checks green');
  if (main.ciStatus === 'red' && main.rerunAttempts === 0) return result('rerun-main-once', 'main CI red at head, first attempt');
  if (issue.ask) {
    const { category, scopeKind, recommendation, openedAt } = issue.ask;
    if (now - openedAt <= ASK_TIMEOUT_MS) return result('wait', 'ask pending under 24h');
    if (RED_LINE.has(category) || scopeKind === 'scope-change') return result('wait', `red-line ask suspended: ${category}`);
    if (recommendation) return result('default-answer', 'non-red-line ask timed out with recommendation');
    return result('wait', 'ask timed out without recommendation');
  }
  const blocked = issue.blocked;
  if (blocked && RETRY_CAUSES.has(blocked.cause)) {
    if (blocked.autoRetries >= 1) return result('wait', 'second block after auto-retry: digest');
    if (now - blocked.at < BLOCK_RETRY_MS) return result('wait', 'blocked under 6h');
    return result('retry-blocked', `${blocked.cause} block, first retry after 6h`);
  }
  return result('wait', 'no terminal action');
}

/** @returns {{ action: string, reason: string, ledger: object | null }} */
export function reconcile(issueFacts, prFacts, mainFacts, localStatus) {
  const { action, reason } = candidate(issueFacts, prFacts, mainFacts, localStatus);
  if (action === 'wait') return { action, reason, ledger: null };
  const head = prFacts?.head ?? mainFacts.head;
  const key = actionKey(issueFacts.number, head, action);
  if (localStatus.doneKeys.includes(key)) return { action: 'wait', reason: `already done: ${key}`, ledger: null };
  const ledger = SELF_ACTIONS.has(action) ? { kind: 'self', issue: issueFacts.number, head, action, key } : null;
  return { action, reason, ledger };
}
