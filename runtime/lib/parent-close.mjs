/**
 * Reason to auto-close a parent issue that needs no PR, or null to keep it open.
 * Closes only when its acceptance is verified, it has children, all children are closed and main CI is green.
 */
export function parentCloseReason({ hasPullRequest, acceptanceMet, children = [], mainCi }) {
  if (hasPullRequest || !acceptanceMet || children.length === 0 || children.some((state) => state !== 'CLOSED') || mainCi !== 'success') return null;
  return `no PR needed: acceptance verified, all ${children.length} sub-issues closed, main CI green`;
}

/** Close the parent through the injected adapter exactly once when its close reason is met; otherwise do nothing. */
export async function autoCloseParent({ parent, state, close }) {
  const reason = parentCloseReason(state);
  if (!reason) return { closed: false, reason: null };
  await close(parent, reason);
  return { closed: true, reason };
}
