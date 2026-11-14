/**
 * Decision state machine (RT-4, issue #29). Pure and deterministic: no I/O, no network, no GitHub calls,
 * and no merge transition. `decide` validates an untrusted decision input and returns it normalized;
 * `classifyPause` applies the rule-based `production` detection; pause provenance is checked by
 * `validPause` / `resumeFromPause`; `pickQueue` drops `rt:proposed` items. Standalone: nothing imports it yet.
 */

/** The closed ask list (policy). `merge` is deliberately not a category: merge is automatic. */
export const ASK_CATEGORIES = Object.freeze(['scope', 'credentials', 'destructive', 'direction', 'production']);
export const DECISIONS = Object.freeze(['continue', 'wait', 'ask', 'done', 'stop']);
const STOP_REASONS = Object.freeze(['budget', 'policy']);
const DEFAULT_PRODUCTION_LABELS = Object.freeze(['deploy', 'production', 'live']);

export class IllegalTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IllegalTransitionError';
    this.code = code;
  }
}

/** Validate an untrusted decision input and return it normalized, or throw. */
export function decide(input) {
  if (typeof input !== 'object' || input === null) throw new TypeError('Decision input must be an object');
  switch (input.decision) {
    case 'done':
      if (!input.pr || input.ciGreen !== true || input.reviewAccepted !== true) {
        throw new IllegalTransitionError('DONE_NOT_READY', 'done needs a PR, green CI and an accepted review');
      }
      return { decision: 'done', pr: input.pr, ciGreen: true, reviewAccepted: true };
    case 'ask':
      if (!ASK_CATEGORIES.includes(input.category)) {
        throw new IllegalTransitionError('ILLEGAL_ASK_CATEGORY', `ask category must be one of ${ASK_CATEGORIES.join(', ')}`);
      }
      return { decision: 'ask', category: input.category, question: input.question };
    case 'wait':
      if (!input.event) throw new IllegalTransitionError('WAIT_NO_EVENT', 'wait needs an event binding');
      if (!Number.isFinite(Date.parse(input.unblockAt))) {
        throw new IllegalTransitionError('WAIT_NO_UNBLOCK', 'wait needs an unblock/retry timestamp');
      }
      return { decision: 'wait', event: input.event, unblockAt: input.unblockAt };
    case 'stop':
      if (!STOP_REASONS.includes(input.reason)) throw new IllegalTransitionError('ILLEGAL_STOP_REASON', 'stop reason must be budget or policy');
      return { decision: 'stop', reason: input.reason };
    case 'continue':
      return { decision: 'continue' };
    default:
      throw new IllegalTransitionError('UNKNOWN_DECISION', `Unknown decision ${String(input.decision)}`);
  }
}

/**
 * Rule-based `production` detection. Config (per repo, optional): `productionLabels` (default deploy/production/live),
 * `bodyPatterns` (regex sources), `diffPrefixes` (path prefixes). A match yields `ask`/`production`, otherwise `continue`.
 */
export function classifyPause({ labels = [], body = '', diffPaths = [] } = {}, config = {}) {
  const { productionLabels = DEFAULT_PRODUCTION_LABELS, bodyPatterns = [], diffPrefixes = [] } = config;
  const label = labels.find((l) => productionLabels.includes(l));
  if (label !== undefined) return { decision: 'ask', category: 'production', rule: `label:${label}` };
  const pattern = bodyPatterns.find((p) => new RegExp(p).test(body));
  if (pattern !== undefined) return { decision: 'ask', category: 'production', rule: `body:${pattern}` };
  const path = diffPaths.find((p) => diffPrefixes.some((prefix) => p.startsWith(prefix)));
  if (path !== undefined) return { decision: 'ask', category: 'production', rule: `path:${path}` };
  return { decision: 'continue' };
}

/** A pause is valid only with complete provenance and when the issue has not changed since it was recorded. */
export function validPause(pause, issue) {
  const { runnerId, runId, at, issueUpdatedAt } = pause ?? {};
  if (!runnerId || !runId || !at || !issueUpdatedAt) return null;
  return issue?.updatedAt === issueUpdatedAt ? pause : null;
}

/** A void pause re-queues the issue to `continue`; a valid one is kept as-is. */
export function resumeFromPause(pause, issue) {
  return validPause(pause, issue) ?? { decision: 'continue' };
}

/** Queue picker: `rt:proposed` items are never runnable (with or without `rt:approved`). Order is preserved. */
export function pickQueue(issues) {
  return issues.filter((issue) => !issue.labels?.includes('rt:proposed'));
}
