// Deterministic supervisor signal loop. Pure: no fs, network or Date.now; `now` is passed in.
// Input: task rows from the ledger snapshot { id, status, owner, checkpoint, askedAt, heartbeatAt, startError }.
// Output: findings [{ kind, signature, taskId, evidence }]; signature = `${kind}:${taskId}` keys on the condition.
// createSignalLoop dedupes, merges, rate-limits and holds the findings into messages. Observe-only.

export const SIGNAL_KINDS = Object.freeze([
  'pending-review', 'stopped-midway', 'ask-timeout', 'stalled', 'start-failed', 'orphaned',
]);
const ACTIVE = Object.freeze(['running', 'asking', 'pending-review']);
const MINUTE = 60_000;
const DEFAULTS = Object.freeze({ askTimeoutMs: 120 * MINUTE, stallMs: 30 * MINUTE });

const finding = (kind, task, evidence) => ({ kind, signature: `${kind}:${task.id}`, taskId: task.id, evidence });

export const detectPendingReview = (tasks) =>
  tasks.filter((t) => t.status === 'pending-review').map((t) => finding('pending-review', t, { status: t.status }));

export const detectStoppedMidway = (tasks) =>
  tasks.filter((t) => t.status === 'stopped' && t.checkpoint !== null).map((t) => finding('stopped-midway', t, { status: t.status }));

export const detectAskTimeout = (tasks, now, config = {}) => {
  const limit = config.askTimeoutMs ?? DEFAULTS.askTimeoutMs;
  return tasks.filter((t) => t.status === 'asking' && t.askedAt !== null && now - t.askedAt >= limit)
    .map((t) => finding('ask-timeout', t, { ageMs: now - t.askedAt }));
};

export const detectStalled = (tasks, now, config = {}) => {
  const limit = config.stallMs ?? DEFAULTS.stallMs;
  return tasks.filter((t) => t.status === 'running' && t.heartbeatAt !== null && now - t.heartbeatAt >= limit)
    .map((t) => finding('stalled', t, { ageMs: now - t.heartbeatAt }));
};

export const detectStartFailed = (tasks) =>
  tasks.filter((t) => t.startError !== null).map((t) => finding('start-failed', t, { startError: t.startError }));

export const detectOrphaned = (tasks) =>
  tasks.filter((t) => t.owner === null && ACTIVE.includes(t.status)).map((t) => finding('orphaned', t, { status: t.status }));

const DETECTORS = Object.freeze([detectPendingReview, detectStoppedMidway, detectAskTimeout, detectStalled, detectStartFailed, detectOrphaned]);

/** @returns {{ kind: string, signature: string, taskId: string, evidence: object }[]} */
export function detectSignals(tasks, now, config = {}) {
  return DETECTORS.flatMap((detect) => detect(tasks, now, config));
}

/** Latest `at` among comments authored by `owner`, or null. Comments: [{ author, at }]. */
export function ownerActiveAt(comments, owner) {
  const times = comments.filter((c) => c.author === owner).map((c) => c.at);
  return times.length ? Math.max(...times) : null;
}

/**
 * Signal loop. cycle({ findings, now, ownerActiveAt }) returns { message, held }.
 * A message is { at, signatures, text }, one line per signature ("kind taskId"), in signature order.
 */
export function createSignalLoop({ windowMs = 30 * MINUTE, holdMs = 10 * MINUTE } = {}) {
  const sent = new Set();
  let pending = new Set();
  const lastSentAt = new Map();

  return {
    cycle({ findings, now, ownerActiveAt: ownerAt }) {
      const bySignature = new Map(findings.map((f) => [f.signature, f]));
      const active = new Set(bySignature.keys());
      for (const sig of sent) if (!active.has(sig)) sent.delete(sig);
      const fresh = [...active].filter((sig) => !sent.has(sig));
      pending = new Set([...pending, ...fresh].filter((sig) => active.has(sig)));
      if (pending.size === 0) return { message: null, held: 0 };

      const signatures = [...pending].sort();
      const setKey = signatures.join('|');
      if (ownerAt !== null && now - ownerAt < holdMs) return { message: null, held: pending.size };
      if (lastSentAt.has(setKey) && now - lastSentAt.get(setKey) < windowMs) return { message: null, held: pending.size };

      const text = signatures.map((sig) => sig.replace(':', ' ')).join('\n');
      for (const sig of signatures) sent.add(sig);
      pending = new Set();
      lastSentAt.set(setKey, now);
      return { message: { at: now, signatures, text }, held: 0 };
    },
  };
}
