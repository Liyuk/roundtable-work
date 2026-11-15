// Self-supervision metrics (#419). `selfMetrics` is pure: entries, freezes and `now` are data, with no fs and no clock.
// Window W = [now - windowDays, now). Times are epoch ms inside; every output duration is in hours, unrounded.
const DAY = 86_400_000;
const HOUR = 3_600_000;
const hours = (ms) => ms / HOUR;
const at = (entry) => Date.parse(entry.at);
const counted = (entry) => ['owner', 'external'].includes(entry.source) && entry.category !== 'owner-only';
const clip = ([start, end], [lo, hi]) => [Math.max(start, lo), Math.min(end, hi)];
const countBy = (list) => list.reduce((acc, entry) => ({ ...acc, [entry.category]: (acc[entry.category] ?? 0) + 1 }), {});
const tally = (list) => ({ total: list.length, byCategory: countBy(list) });

// Union of [start, end) intervals as sorted, disjoint intervals; empty intervals are dropped.
function merge(intervals) {
  const out = [];
  for (const [start, end] of intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}
const length = (intervals) => intervals.reduce((sum, [start, end]) => sum + end - start, 0);

/** Pure: self-supervision metrics for the window ending at `now`. Durations are hours; `na` objects carry a reason. */
export function selfMetrics({ entries, freezes, now, windowDays }) {
  const lo = now - windowDays * DAY;
  const frozen = freezes.filter((f) => f.class === 'host-freeze').map((f) => [f.start, f.end]);
  const ownerKinds = entries.filter((e) => e.source === 'owner' && e.kind).map((e) => [at(e), e.kind]).sort((a, b) => a[0] - b[0]);
  const paused = ownerKinds.filter(([, kind]) => kind === 'pause').map(([start]) => {
    const resume = ownerKinds.find(([time, kind]) => kind === 'resume' && time >= start);
    return [start, resume?.[0] ?? now];
  });
  // Measures in [from, to): frozen, paused outside freeze, and unsupervised = length minus the union of both.
  const measure = (from, to) => {
    const window = [from, to];
    const f = length(merge(frozen.map((i) => clip(i, window))));
    const covered = length(merge([...frozen, ...paused].map((i) => clip(i, window))));
    return { frozen: f, paused: covered - f, unsupervised: to - from - covered };
  };
  const inWindow = (e) => at(e) >= lo && at(e) < now;
  const counts = entries.filter(counted);
  const w = measure(lo, now);
  const interventions = counts.filter(inWindow).length;

  let streak = { na: 'intervention ledger is empty' };
  if (counts.length) streak = hours(measure(Math.max(...counts.map(at)), now).unsupervised);
  else if (entries.length) streak = hours(measure(at(entries[0]), now).unsupervised);

  const lastByRef = new Map(entries.map((e) => [e.ref, e]));
  const repairRefs = [...new Set(entries.filter((e) => e.category === 'self-repair').map((e) => e.ref))];
  const internalizedShare = repairRefs.length
    ? repairRefs.filter((ref) => lastByRef.get(ref).internalized === 'yes').length / repairRefs.length
    : { na: 'no self-repair entries' };

  const inW = entries.filter(inWindow);
  return {
    window: { since: new Date(lo).toISOString(), until: new Date(now).toISOString() },
    frozenHours: hours(w.frozen),
    pausedHours: hours(w.paused),
    unsupervisedHours: hours(w.unsupervised),
    interventions,
    mtbi: interventions > 0 ? { value: hours(w.unsupervised) / interventions, bound: null } : { value: hours(w.unsupervised), bound: 'lower' },
    streak,
    pullIns: {
      owner: tally(counts.filter(inWindow).filter((e) => e.source === 'owner')),
      external: tally(counts.filter(inWindow).filter((e) => e.source === 'external')),
    },
    selfActions: tally(inW.filter((e) => e.source === 'self')),
    internalizedShare,
  };
}
