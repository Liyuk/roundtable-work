// Owner digest and anomaly alerts (RT-S11, docs/self-supervision.md). `buildDigest` and `anomalies` are pure: entries,
// metrics, merges and actions are data. The enqueue helpers write through the outbox under cause-derived ids
// (`notice:digest:<date>`, `notice:anomaly:<rule>:<date>`), so a replayed firing enqueues nothing.
import { scanHygiene } from './hygiene.mjs';

export const DIGEST_TIMER = 'digest:daily';
const DAY = 86_400_000;
const MAX_LINES = 30;
const utcDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const hours = (value) => (typeof value === 'number' ? value.toFixed(1) : 'n/a');
const inWindow = (window, entry) => Date.parse(entry.at) >= Date.parse(window.since) && Date.parse(entry.at) < Date.parse(window.until);

/** Pure: the anomaly rules that fire. `thresholds` is goals.metrics; `deadLetters` counts dead outbox items. */
export function anomalies({ entries, metrics, thresholds, deadLetters }) {
  const fired = [];
  if (entries.some((e) => e.source === 'self' && e.reason === 'restart-exhausted' && inWindow(metrics.window, e))) fired.push('restart-exhausted');
  if (metrics.interventions > 0) fired.push('intervention');
  const days = (Date.parse(metrics.window.until) - Date.parse(metrics.window.since)) / DAY;
  const breached = metrics.mtbi.value < thresholds.mtbiHoursMin
    || (typeof metrics.firstPassRate === 'number' && metrics.firstPassRate < thresholds.firstPassRateMin)
    || metrics.pullIns.owner.total * 7 / days > thresholds.ownerPullInsPerWeekMax;
  if (breached) fired.push('threshold');
  if (deadLetters > 0) fired.push('dead-letter');
  return fired;
}

/** Pure: the digest text (at most 30 lines), or null when there is no merge, no default decision and no anomaly. */
export function buildDigest({ window, metrics, entries, merged, actions, stage, thresholds, deadLetters }) {
  const fired = anomalies({ entries, metrics, thresholds, deadLetters });
  const decisions = actions.filter((a) => a.kind === 'decision');
  if (!merged.length && !decisions.length && !fired.length) return null;
  const selfIssues = entries.filter((e) => e.source === 'self' && e.category === 'backlog' && inWindow(window, e));
  const ownerOnly = entries.filter((e) => e.category === 'owner-only' && inWindow(window, e));
  const { mtbi } = metrics;
  const lines = [
    `Roundtable digest ${window.since} to ${window.until}`,
    `Stage: ${stage}`,
    `Anomalies: ${fired.join(', ') || 'none'}`,
    `Merged PRs: ${merged.length}`,
    ...merged.map((pr) => `- PR #${pr.number} merged at ${pr.mergedAt}`),
    `Default decisions: ${decisions.length}`,
    ...decisions.map((a) => `- ${a.id} on #${a.issue} (rollback: /rt rollback ${a.id})`),
    `Self-sourced issues: ${selfIssues.length}`,
    ...selfIssues.map((e) => `- ${e.ref}`),
    `Counted interventions: ${metrics.interventions}`,
    `MTBI: ${hours(mtbi.value)} h${mtbi.bound ? ` (${mtbi.bound} bound)` : ''}`,
    `Streak: ${hours(metrics.streak)} h`,
    `Owner-only actions: ${ownerOnly.length}`,
    ...ownerOnly.map((e) => `- ${e.ref}: ${e.reason}`),
  ];
  return lines.slice(0, MAX_LINES).join('\n');
}

/** Registers the recurring daily digest timer once, at the next digestHourUtc. */
export function ensureDigestTimer(timers, goals, now) {
  if (timers.list().some((t) => t.id === DIGEST_TIMER)) return;
  const at = new Date(now);
  at.setUTCHours(goals.reporting.digestHourUtc, 0, 0, 0);
  if (at.getTime() < now) at.setTime(at.getTime() + DAY);
  timers.recurring({ id: DIGEST_TIMER, at: at.toISOString(), cadenceMs: DAY, event: { kind: 'heartbeat', issue: null, payload: { job: 'digest' } } });
}

/** Items that were enqueued but are neither pending nor delivered: the dead letters. */
export function deadLetterCount(outbox) {
  const live = new Set([...outbox.pending().map((i) => i.id), ...outbox.receipts().keys()]);
  return outbox.items().filter((i) => !live.has(i.id)).length;
}

/** Enqueues today's digest: a comment on the digest issue, or a digest notification without one. Returns whether it enqueued. */
export async function enqueueDigest({ outbox, now, issue, text, hygiene }) {
  if (text === null) return false;
  if ((await scanHygiene({ entries: [{ value: text }], ...hygiene })).length) return false;
  const id = `notice:digest:${utcDate(now)}`;
  if (issue === null) return outbox.enqueue({ id, kind: 'notification', issue: null, payload: { subtype: 'digest', body: text } });
  return outbox.enqueue({ id, kind: 'comment', issue, payload: { body: text } });
}

/** Enqueues one stall-alert notification per fired rule for the current UTC day. Returns the ids it enqueued. */
export function enqueueAnomalies({ outbox, now, fired }) {
  const added = [];
  for (const rule of fired) {
    const id = `notice:anomaly:${rule}:${utcDate(now)}`;
    if (outbox.enqueue({ id, kind: 'notification', issue: null, payload: { subtype: 'stall-alert', of: rule } })) added.push(id);
  }
  return added;
}
