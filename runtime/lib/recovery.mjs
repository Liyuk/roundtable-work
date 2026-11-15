// Recovery table: failure class -> action, budget spend and a retry timer. Pure; `now` is epoch ms.
// Rows follow docs/architecture.md "Recovery table". `timerMs` is the default delay of a `wait` row.
const MIN = 60_000;

export const RECOVERY = Object.freeze({
  'host-freeze': Object.freeze({ action: 'record-freeze', spendsBudget: false }),
  'scheduler-stall': Object.freeze({ action: 'restart', spendsBudget: false }),
  quota: Object.freeze({ action: 'wait', spendsBudget: false, timerMs: 15 * MIN }),
  'provider-timeout': Object.freeze({ action: 'wait', spendsBudget: false, timerMs: 5 * MIN }),
  'invalid-output': Object.freeze({ action: 'reask', spendsBudget: false }),
  'gh-write-failed': Object.freeze({ action: 'backoff-dead-letter', spendsBudget: false }),
  'ci-red': Object.freeze({ action: 'fix-round', spendsBudget: true }),
  'ci-cancelled': Object.freeze({ action: 'rerun-then-hold', spendsBudget: false }),
  'main-red-after-merge': Object.freeze({ action: 'pause-and-revert', spendsBudget: false }),
  'merge-unknown': Object.freeze({ action: 'hold', spendsBudget: false }),
  'claim-stuck': Object.freeze({ action: 'release-claim', spendsBudget: false }),
  'revert-failed': Object.freeze({ action: 'hold', spendsBudget: false }),
});

/** failure: a class string or { class, retryAfterMs?, reasked? }. Unknown classes hold and alert. */
export function recover(failure, { now = Date.now() } = {}) {
  const { class: cls, retryAfterMs, reasked } = typeof failure === 'string' ? { class: failure } : failure;
  if (!Object.hasOwn(RECOVERY, cls)) return { action: 'hold-and-alert', spendsBudget: false };
  if (cls === 'invalid-output') return { action: reasked ? 'fallback' : 'reask', spendsBudget: false };
  const rule = RECOVERY[cls];
  if (rule.timerMs === undefined) return { action: rule.action, spendsBudget: rule.spendsBudget };
  return { action: 'wait', spendsBudget: false, timer: { at: now + (retryAfterMs ?? rule.timerMs) } };
}
