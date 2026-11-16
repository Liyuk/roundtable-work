// Stage checker and observer mode (#430, RT-S12). `stage` and `exitConditions` are pure: entries, freezes, merges and
// closures are data, and `now` is the only clock. Times in entries are ISO strings; freeze times are epoch ms.
import { selfMetrics } from './self-metrics.mjs';
import { ALLOWED_ACTIONS } from '../supervisor/actuator.mjs';
import { DEFAULT_POLL_MS, watchdogVerdict } from './daemon-loop.mjs';
import observer from '../defaults/observer.json' with { type: 'json' };

const DAY = 86_400_000;
const HOUR = 3_600_000;
const at = (item) => Date.parse(item.at);
const counted = (entry) => ['owner', 'external'].includes(entry.source) && entry.category !== 'owner-only';
const within = (items, from, to) => items.filter((item) => at(item) >= from && at(item) < to);
const lastDays = (items, days, now) => within(items, now - days * DAY, now);
const NOT_COMPLETED = ['not_planned', 'duplicate'];
const CAPABILITY_CATEGORY = { L: 'liveness', H: 'self-repair', R: 'resource', D: 'decision', M: 'merge', B: 'backlog', S: 'self-review', O: 'reporting' };

// Stage measures M1..M4. Each returns the names of the conditions it does not meet (empty = holds).
const MEASURES = [
  ({ entries, now }) => {
    const unmet = [];
    if (Array.from({ length: 7 }, (_, d) => within(entries, now - (d + 1) * DAY, now - d * DAY).length).includes(0)) unmet.push('ledger has a day with no entry in the last 7 days');
    if (entries.some((e) => e.source === 'owner' && !e.category)) unmet.push('owner entry not classified');
    return unmet;
  },
  ({ entries, freezes, heartbeatVerdict, now }) => {
    const week = lastDays(entries, 7, now);
    const unmet = [];
    if (week.some((e) => counted(e) && ['liveness', 'resource'].includes(e.category))) unmet.push('counted liveness or resource entry in the last 7 days');
    const recovered = freezes.some((f) => f.class === 'host-freeze' && f.end >= now - 7 * DAY && f.end < now && heartbeatVerdict === 'fresh' && !entries.some((e) => counted(e) && at(e) > f.end));
    if (!recovered) unmet.push('no host-freeze recovered by a fresh heartbeat without counted entry');
    if (week.some((e) => e.category === 'self-repair' && e.internalized === 'no')) unmet.push('self-repair entry with internalized no in the last 7 days');
    return unmet;
  },
  ({ entries, now }) => (lastDays(entries, 14, now).some((e) => counted(e) && e.category === 'decision') ? ['counted decision entry in the last 14 days'] : []),
  ({ entries, selfSourcedClosed, now }) => {
    const fortnight = lastDays(entries, 14, now);
    const closed = lastDays(selfSourcedClosed, 14, now);
    const unmet = [];
    if (fortnight.some((e) => counted(e) && ['backlog', 'self-review'].includes(e.category))) unmet.push('counted backlog or self-review entry in the last 14 days');
    if (closed.length < 3) unmet.push('fewer than 3 self-sourced issues closed by merged PR in 14 days');
    if (closed.filter((c) => NOT_COMPLETED.includes(c.stateReason)).length > 0.2 * closed.length) unmet.push('more than 20% of self-sourced closures not planned or duplicate');
    return unmet;
  },
];

/** Pure: the heartbeat verdict at `now` (fresh, host-freeze, stale or missing), mapped from the watchdog verdict. */
export function heartbeatVerdict({ heartbeat, freezes, now }) {
  if (!heartbeat?.ok) return 'missing';
  return watchdogVerdict({ heartbeat, ledgerEntries: freezes, now, pollMs: DEFAULT_POLL_MS }).reason;
}

/** Pure: the final exit criterion over W = [now - exit.windowHours, now). Each condition: { name, ok, value }. */
export function exitConditions({ entries, freezes, heartbeatVerdict, lastCycleAt, merged, selfSourcedClosed, goals, now }) {
  const { windowHours, minMergedPrs, minSelfSourcedCompleted } = goals.exit;
  const from = now - windowHours * HOUR;
  const window = entries.filter((e) => at(e) >= from && at(e) < now);
  const interventions = window.filter(counted).length;
  const mergedPrs = within(merged, from, now).length;
  const completed = within(selfSourcedClosed, from, now).length;
  const restarts = window.filter((e) => e.source === 'self' && e.reason === 'restart-exhausted').length;
  const stalls = freezes.filter((f) => f.class === 'scheduler-stall' && f.end > from && f.start < now);
  const unrecovered = stalls.filter((f) => !(f.end <= now && lastCycleAt >= f.end)).length;
  const freezeViolations = (['fresh', 'host-freeze'].includes(heartbeatVerdict) ? 0 : 1) + restarts + unrecovered;
  const slices = Math.ceil(windowHours / 24);
  const covered = Array.from({ length: slices }, (_, k) => window.some((e) => e.source === 'self' && at(e) >= from + k * DAY && at(e) < Math.min(from + (k + 1) * DAY, now))).filter(Boolean).length;
  return [
    { name: 'interventions', ok: interventions === 0, value: interventions },
    { name: 'merged-prs', ok: mergedPrs >= minMergedPrs, value: mergedPrs },
    { name: 'self-sourced-completed', ok: completed >= minSelfSourcedCompleted, value: completed },
    { name: 'freezes', ok: freezeViolations === 0, value: freezeViolations },
    { name: 'recording', ok: covered === slices, value: covered },
  ];
}

/** Pure: current stage (0-5), streak, MTBI, measured capability levels and the unmet items for the next step. */
export function stage(input) {
  const { entries, freezes, now, goals } = input;
  const measures = MEASURES.map((measure) => measure(input));
  const holds = measures.findIndex((unmet) => unmet.length > 0);
  const reached = holds === -1 ? 4 : holds;
  const current = entries.length === 0 ? 0 : Math.min(reached + 1, 5);
  const unmet = current === 5
    ? exitConditions(input).filter((c) => !c.ok).map((c) => `final exit: ${c.name}`)
    : measures[Math.max(current, 1) - 1];
  const metrics = selfMetrics({ entries, freezes, now, windowDays: goals.metrics.windowDays });
  const capabilities = Object.fromEntries(Object.entries(CAPABILITY_CATEGORY).map(([letter, category]) => [
    letter,
    lastDays(entries, 14, now).some((e) => counted(e) && e.category === category) ? 'external' : 'self',
  ]));
  return {
    stage: current,
    streakHours: metrics.streak,
    mtbi: metrics.mtbi,
    capabilities,
    unmet,
  };
}

/** Observer mode: true only for names in observer.json `allowed`; every actuator action and unknown name is false. */
export function observerAllows(action) {
  return observer.allowed.includes(action) && !observer.denied.includes(action) && !ALLOWED_ACTIONS.includes(action);
}
