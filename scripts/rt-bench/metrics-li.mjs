// rt-bench L1-L5 and I1-I5 (docs/autonomy-benchmark.md sections 4, 5 and 8). Pure: `now` is passed in; no clock, no I/O, no network.
// Same window, productionStart and result shape as metrics-u.mjs (`result`, level cutoffs and the not-measurable rule mirror it).
// Normalized sources; each is { asOf (epoch ms), ... } and a missing or stale source gives level 0, not measurable:
//   github:       { asOf, issues: [{ number, createdAt, closedAt, labels: [names], body }],
//                   prs: [{ number, title, mergedAt, closes: [issue numbers], revertOf }] }   (GitHub reader is out of scope)
//   sched:        { asOf, events } from readSchedLog (sched-log.mjs): kinds start, spawn, stage (gap unused here)
//   deploys:      { asOf, events: [{ at, kind: 'pr' | 'hand', pr?, tag? }] }                  I1
//   handPatches:  { asOf, events: [{ at, tag }] }                                           I2
//   failures:     { asOf, events: [{ at, signature, issue }] }                              I3
//   issueActivity:{ asOf, events: [{ at, issue, signature }] }  loop-filed or loop-updated   I3
//   changeEvals:  { asOf, events: [{ pr, metric, preRegistered, mergedAt, evaluatedAt, verdict }] }   I4
//   daily:        { asOf, events: [{ day: 'YYYY-MM-DD', first_pass_n, rework_n }] }            I5
// Decisions (the spec leaves these open):
// - PR -> issue: the first entry of `closes`. A PR with no closes is tied to no issue and counts alone.
// - Self-originated: labelled `rt:self` and no `Parent: #N` line in the body. Decomposition children are never self-originated.
// - Revert: `revertOf` set, or title starts with `Revert`. Revert PRs are not work. A merged PR named by a merged revert's `revertOf` is removed from every count.
// - Loop merges (L3 denominator) = merged, non-revert, non-reverted PRs merged in W. Child merges stay in the denominator, never in the numerator.
// - Several merged PRs for one issue within 24 h count once (the first one counted anchors the 24 h).
// - L1 days = the 7 slices (NOW - 24(k+1) h, NOW - 24k h] that contain a counted self merge. L4 = issues created in W without rt:self or rt:followup, divided by the window length in days (7 when full).
// - L2 = self-originated issues closed in W that have a merged, non-reverted PR closing them, over all self-originated issues closed in W.
// - L5 is a PROXY (result `proxy: true`): zero-worker hours in W from sched.log spawn/exit pairs (unmatched spawn runs to now; unmatched exit starts at window start). No quota exclusion, no freeze, no queue snapshot.
// - L2, L3 and I1-I4 with a zero denominator: value null, measurable false, level 0.
// - I3: a signature qualifies with >= 3 occurrences in W. Its closure = loop issue activity for that signature in [3rd occurrence, 3rd + 24 h].
// - I4: the 7-day evaluation point (mergedAt + 7 d) is the window point; a change counts when that point is in W. This deviates from a literal "merged in W": a PR merged inside a 7-day W cannot be evaluated 7 d later inside it. Kept = preRegistered and evaluatedAt >= mergedAt + 7 d.
// - I5 value = sum(first_pass_n) / sum(first_pass_n + rework_n) over daily rows whose day is in W (UTC date strings; daily rows are Pacific days, so the edge days can differ by up to a day). Level 5 needs n >= 20 (n = the PR count); below that the level is capped at 4.
// - Merge ledger (readMerges): not read here. Merge timing comes from GitHub `mergedAt`.
import { measure } from './score.mjs';
import { PRODUCTION_START } from './metrics-u.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW = 7 * DAY;

const t = (e, key = 'at') => Date.parse(e[key]);
const byTime = (a, b) => t(a) - t(b);
const iso = (ms) => new Date(ms).toISOString();
// Ascending bands: the level is the number of cutoffs reached.
const up = (value, cuts) => cuts.filter((c) => value >= c).length;
// Descending bands: the level is the number of cutoffs the value is at or under.
const down = (value, cuts) => cuts.filter((c) => value <= c).length;

function result({ id, value, level, now, start, asOf, evidence, ok = true }) {
  const m = measure({ id, level: ok ? level : 0, source: { asOf } }, now);
  return { id, value, level: m.level, window: { start: iso(start), end: iso(now) }, source: m.source, measurable: m.measurable && ok, evidence };
}

export function computeLI({ now, productionStart = PRODUCTION_START, sources = {} }) {
  const S = { github: {}, sched: {}, deploys: {}, handPatches: {}, failures: {}, issueActivity: {}, changeEvals: {}, daily: {}, ...sources };
  const issues = S.github.issues ?? [];
  const prs = S.github.prs ?? [];
  const start = Math.max(now - WINDOW, productionStart);
  const inW = (ms, from = start) => ms >= from && ms <= now;
  const W = (events = [], key = 'at') => events.filter((e) => inW(t(e, key))).sort((a, b) => t(a, key) - t(b, key));
  const days = (now - start) / DAY;

  // Reverts: a merged revert removes the PR it names; reverts are not work.
  const isRevert = (p) => p.revertOf !== undefined || /^Revert/.test(p.title);
  const reverted = new Set(prs.filter((p) => p.mergedAt && p.revertOf !== undefined).map((p) => p.revertOf));
  const good = prs.filter((p) => p.mergedAt && !isRevert(p) && !reverted.has(p.number));

  // Loop merges in W; several merges of one issue within 24 h count once.
  const seen = new Map();
  const loopMerges = W(good, 'mergedAt').filter((p) => {
    const key = p.closes[0] ?? `pr${p.number}`;
    const prev = seen.get(key);
    if (prev !== undefined && t(p, 'mergedAt') - prev < DAY) return false;
    seen.set(key, t(p, 'mergedAt'));
    return true;
  });

  const self = new Set(issues.filter((i) => i.labels.includes('rt:self') && !/^Parent: #\d+/m.test(i.body)).map((i) => i.number));
  const selfMerges = loopMerges.filter((p) => p.closes.some((n) => self.has(n)));
  const issueInW = (i) => i.closedAt && inW(t(i, 'closedAt'));

  // L1: 24 h slices (NOW - 24(k+1) h, NOW - 24k h] holding a self merge.
  const slices = Array.from({ length: 7 }, (_, k) => [now - DAY * (k + 1), now - DAY * k]);
  const l1 = slices.filter(([lo, hi]) => selfMerges.some((p) => t(p, 'mergedAt') > lo && t(p, 'mergedAt') <= hi)).length;

  // L2: self-originated issues closed in W, and those backed by a merged, non-reverted PR.
  const closedSelf = issues.filter((i) => self.has(i.number) && issueInW(i));
  const accepted = closedSelf.filter((i) => good.some((p) => p.closes.includes(i.number)));
  const l2 = (100 * accepted.length) / closedSelf.length;

  const l3 = (100 * selfMerges.length) / loopMerges.length;

  const external = issues.filter((i) => inW(t(i, 'createdAt')) && !i.labels.some((l) => l === 'rt:self' || l === 'rt:followup'));
  const l4 = external.length / days;

  // L5 (proxy): busy spans from spawn/exit pairs, clipped to W and merged; idle = the rest of W.
  const open = new Map();
  const spans = [];
  for (const e of (S.sched.events ?? []).filter((x) => x.kind === 'spawn' || x.kind === 'stage').sort(byTime)) {
    if (e.kind === 'spawn') open.set(e.worker, t(e));
    else {
      spans.push([open.get(e.worker) ?? start, t(e)]);
      open.delete(e.worker);
    }
  }
  for (const at of open.values()) spans.push([at, now]);
  const busy = spans.map(([a, b]) => [Math.max(a, start), Math.min(b, now)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let end = -Infinity;
  for (const [a, b] of busy) {
    covered += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  const l5 = (now - start - covered) / HOUR;

  // I1-I2: runtime changes and hand patches.
  const deploys = W(S.deploys.events);
  const prShipped = deploys.filter((e) => e.kind === 'pr').length;
  const i1 = deploys.length ? (100 * prShipped) / deploys.length : null;
  const handTags = new Set(W(S.handPatches.events).map((e) => e.tag)).size;

  // I3: signatures with >= 3 occurrences in W; closed if loop activity follows the 3rd within 24 h.
  const occurrences = new Map();
  for (const f of W(S.failures.events)) occurrences.set(f.signature, [...(occurrences.get(f.signature) ?? []), t(f)]);
  const qualifying = [...occurrences].filter(([, ts]) => ts.length >= 3).map(([sig, ts]) => ({ sig, at: ts[2] }));
  const closedSigs = qualifying.filter(({ sig, at }) => (S.issueActivity.events ?? []).some((a) => a.signature === sig && t(a) >= at && t(a) <= at + DAY));
  const i3 = qualifying.length ? (100 * closedSigs.length) / qualifying.length : null;

  // I4: changes whose 7-day evaluation point is in W; kept when pre-registered and evaluated at or after that point.
  const due = (S.changeEvals.events ?? []).filter((c) => inW(t(c, 'mergedAt') + 7 * DAY));
  const kept = due.filter((c) => c.preRegistered && t(c, 'evaluatedAt') >= t(c, 'mergedAt') + 7 * DAY);
  const i4 = due.length ? (100 * kept.length) / due.length : null;

  // I5: first-pass rate over the daily rows in W; level 5 needs n >= 20.
  const [d0, d1] = [iso(start).slice(0, 10), iso(now).slice(0, 10)];
  const dailyRows = (S.daily.events ?? []).filter((d) => d.day >= d0 && d.day <= d1);
  const firstPass = dailyRows.reduce((sum, d) => sum + d.first_pass_n, 0);
  const n = dailyRows.reduce((sum, d) => sum + d.first_pass_n + d.rework_n, 0);
  const i5 = n ? firstPass / n : null;

  return [
    result({ id: 'L1', value: l1, level: up(l1, [1, 2, 4, 6, 7]), now, start, asOf: S.github.asOf, evidence: selfMerges }),
    result({ id: 'L2', value: l2, level: up(l2, [20, 40, 55, 70, 80]), now, start, asOf: S.github.asOf, evidence: accepted, ok: closedSelf.length > 0 }),
    result({ id: 'L3', value: l3, level: l3 > 0 ? 1 + up(l3, [8, 15, 25, 40]) : 0, now, start, asOf: S.github.asOf, evidence: selfMerges, ok: loopMerges.length > 0 }),
    result({ id: 'L4', value: l4, level: down(l4, [12, 6, 3, 1, 0.43]), now, start, asOf: S.github.asOf, evidence: external }),
    { ...result({ id: 'L5', value: l5, level: down(l5, [24, 12, 6, 3, 1]), now, start, asOf: S.sched.asOf, evidence: busy.map(([a, b]) => ({ from: iso(a), to: iso(b) })) }), proxy: true },
    result({ id: 'I1', value: i1, level: up(i1, [20, 50, 80, 95, 100]), now, start, asOf: S.deploys.asOf, evidence: deploys, ok: deploys.length > 0 }),
    result({ id: 'I2', value: handTags, level: down(handTags, [12, 6, 3, 1, 0]), now, start, asOf: S.handPatches.asOf, evidence: W(S.handPatches.events) }),
    result({ id: 'I3', value: i3, level: up(i3, [20, 40, 60, 80, 100]), now, start, asOf: S.failures.asOf, evidence: closedSigs, ok: qualifying.length > 0 }),
    result({ id: 'I4', value: i4, level: up(i4, [20, 40, 60, 80, 100]), now, start, asOf: S.changeEvals.asOf, evidence: due, ok: due.length > 0 }),
    result({ id: 'I5', value: i5, level: Math.min(up(i5, [0.7, 0.8, 0.85, 0.9, 0.95]), n >= 20 ? 5 : 4), now, start, asOf: S.daily.asOf, evidence: dailyRows, ok: n > 0 }),
  ];
}
