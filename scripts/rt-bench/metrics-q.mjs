// rt-bench Q1-Q3 output quality (docs/autonomy-benchmark.md section 10). Pure: `now` is passed in; no clock, no I/O.
// Same window, productionStart and result shape as metrics-li.mjs. A missing or stale source, or an empty cohort,
// gives measurable false, level 0 and value null.
// Sources are normalized; each is { asOf (epoch ms), ... }:
//   github:         { asOf, issues: [{ number, body }], prs: [{ number, title, mergedAt, closes: [issue numbers], revertOf }] }
//   outcomes:       { asOf, events: [{ at, pr, kind: 'rework' | 'revert' }] }                                    Q1, Q2
//   benchSnapshots: { asOf, events: [{ at, ids: { [ID]: { value } } }] }                                         Q3
// Decisions:
// - Revert PR = revertOf set or title starts with `Revert`; revert PRs are in no cohort.
// - A PR is flagged by a check point when an outcome event for it, or a merged revert PR naming it (revertOf), is at or before that point.
// - Q1 cohort = non-revert PRs merged in W; value = 100 * flagged by NOW / cohort.
// - Q2 cohort = non-revert PRs whose 14-day point (mergedAt + 14 d) is in W; value = 100 * not flagged by that point / cohort.
// - Q3 per issue: the first merged PR closing it; evaluation point = its mergedAt + `within` d, counted when that point is in W.
//   Observed = ids[ID].value of the first snapshot at or after the point; not counted when no such numeric value exists.
//   Achieved: expected < current -> observed <= expected; otherwise observed >= expected. Value = 100 * achieved / evaluated.
// - Level caps: Q1 and Q2 at 4 when the cohort is below 20; Q3 at 4 when evaluated is below 5.
import { measure } from './score.mjs';
import { PRODUCTION_START } from './metrics-u.mjs';

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 7 * DAY;
const BENCH = /^Bench: ([ULID]\d) (\S+) -> (\S+) \(level \d+ -> \d+\) within (\d+) d\s*$/gm;

const t = (e, key = 'at') => Date.parse(e[key]);
const iso = (ms) => new Date(ms).toISOString();
// Ascending bands: the level is the number of cutoffs reached.
const up = (value, cuts) => cuts.filter((c) => value >= c).length;
// Descending bands: the level is the number of cutoffs the value is at or under.
const down = (value, cuts) => cuts.filter((c) => value <= c).length;
const numeric = (text) => {
  const m = /^(?:<=|>=|<|>)?(-?\d+(?:\.\d+)?)%?$/.exec(text);
  return m ? Number(m[1]) : null;
};
const oldest = (...asOfs) => (asOfs.every(Number.isFinite) ? Math.min(...asOfs) : undefined);

function result({ id, value, level, start, now, asOf, evidence, ok = true }) {
  const m = measure({ id, level: ok ? level : 0, source: { asOf } }, now);
  return { id, value: m.measurable && ok ? value : null, level: m.level, window: { start: iso(start), end: iso(now) }, source: m.source, measurable: m.measurable && ok, evidence };
}

export function computeQ({ now, productionStart = PRODUCTION_START, sources = {} }) {
  const S = { github: {}, outcomes: {}, benchSnapshots: {}, ...sources };
  const prs = S.github.prs ?? [];
  const outcomes = S.outcomes.events ?? [];
  const start = Math.max(now - WINDOW, productionStart);
  const inW = (ms) => ms >= start && ms <= now;

  const isRevert = (p) => p.revertOf !== undefined || /^Revert/.test(p.title);
  const merged = prs.filter((p) => p.mergedAt && !isRevert(p));
  const revertPRs = prs.filter((p) => p.mergedAt && p.revertOf !== undefined);
  const flagged = (p, point) => outcomes.some((e) => e.pr === p.number && t(e) <= point) || revertPRs.some((r) => r.revertOf === p.number && t(r, 'mergedAt') <= point);

  // Q1: rework or revert rate of PRs merged in W, checked at NOW.
  const q1Cohort = merged.filter((p) => inW(t(p, 'mergedAt')));
  const q1Flagged = q1Cohort.filter((p) => flagged(p, now));
  const q1 = (100 * q1Flagged.length) / q1Cohort.length;
  const q1Result = result({
    id: 'Q1', value: q1, level: Math.min(down(q1, [15, 10, 6, 4, 2]), q1Cohort.length >= 20 ? 5 : 4), start, now, asOf: oldest(S.github.asOf, S.outcomes.asOf),
    evidence: q1Flagged.map((p) => ({ pr: p.number })), ok: q1Cohort.length > 0,
  });

  // Q2: PRs whose 14-day point is in W, and those not flagged by that point.
  const q2Cohort = merged.filter((p) => inW(t(p, 'mergedAt') + 14 * DAY));
  const q2Lost = q2Cohort.filter((p) => flagged(p, t(p, 'mergedAt') + 14 * DAY));
  const q2 = (100 * (q2Cohort.length - q2Lost.length)) / q2Cohort.length;
  const q2Result = result({
    id: 'Q2', value: q2, level: Math.min(up(q2, [50, 70, 85, 95, 98]), q2Cohort.length >= 20 ? 5 : 4), start, now, asOf: oldest(S.github.asOf, S.outcomes.asOf),
    evidence: q2Lost.map((p) => ({ pr: p.number })), ok: q2Cohort.length > 0,
  });

  // Q3: per-issue benchmark delta from the Bench: lines of issue bodies.
  const snapshots = [...(S.benchSnapshots.events ?? [])].sort((a, b) => t(a) - t(b));
  const evaluated = [];
  for (const issue of S.github.issues ?? []) {
    for (const [, id, cur, exp, within] of issue.body.matchAll(BENCH)) {
      const current = numeric(cur);
      const expected = numeric(exp);
      const pr = prs.filter((p) => p.mergedAt && p.closes.includes(issue.number)).sort((a, b) => t(a, 'mergedAt') - t(b, 'mergedAt'))[0];
      if (current === null || expected === null || !pr) continue;
      const point = t(pr, 'mergedAt') + Number(within) * DAY;
      if (!inW(point)) continue;
      const observed = snapshots.find((s) => t(s) >= point)?.ids[id]?.value;
      if (!Number.isFinite(observed)) continue;
      const achieved = expected < current ? observed <= expected : observed >= expected;
      evaluated.push({ issue: issue.number, id, current, expected, observed, delta: observed - current, achieved });
    }
  }
  const achieved = evaluated.filter((e) => e.achieved).length;
  const q3 = (100 * achieved) / evaluated.length;
  const q3Result = result({
    id: 'Q3', value: q3, level: Math.min(up(q3, [20, 40, 60, 80, 100]), evaluated.length >= 5 ? 5 : 4), start, now, asOf: oldest(S.github.asOf, S.benchSnapshots.asOf),
    evidence: evaluated, ok: evaluated.length > 0,
  });

  return [q1Result, q2Result, q3Result];
}
