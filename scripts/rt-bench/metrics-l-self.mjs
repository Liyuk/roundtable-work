// rt-bench L6-L8 (docs/autonomy-benchmark.md section 4, owner-proposed). Pure: `now` is passed in; no clock, no I/O.
// Same window, productionStart and result shape as metrics-li.mjs. Source: github only (see metrics-li.mjs for its shape).
// Decisions (the spec leaves these open):
// - Self-originated and good PR: as in metrics-li.mjs (rt:self without a Parent line; merged, non-revert, not reverted).
// - Bench target: the first `Bench: <ULID><digit> ` line of the body. No line = no target.
// - L7/L8 cohort: self-originated issues created in W and at or before now - 24 h.
// - L8: an issue is invalid only when closed and (stateReason not_planned, or labelled duplicate or invalid).
import { measure } from './score.mjs';
import { PRODUCTION_START } from './metrics-u.mjs';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const WINDOW = 7 * DAY;

// Ascending bands: the level is the number of cutoffs reached.
const up = (value, cuts) => cuts.filter((c) => value >= c).length;
// Descending bands: the level is the number of cutoffs the value is at or under.
const down = (value, cuts) => cuts.filter((c) => value <= c).length;

function result({ id, value, level, now, start, asOf, evidence, ok = true }) {
  const m = measure({ id, level: ok ? level : 0, source: { asOf } }, now);
  return { id, value, level: m.level, window: { start: new Date(start).toISOString(), end: new Date(now).toISOString() }, source: m.source, measurable: m.measurable && ok, evidence };
}

export function computeLSelf({ now, productionStart = PRODUCTION_START, sources = {}, lowestIds = [] }) {
  const S = sources.github ?? {};
  const issues = S.issues ?? [];
  const prs = S.prs ?? [];
  const start = Math.max(now - WINDOW, productionStart);
  const inW = (ms) => ms >= start && ms <= now;

  const isRevert = (p) => p.revertOf !== undefined || /^Revert/.test(p.title);
  const reverted = new Set(prs.filter((p) => p.mergedAt && p.revertOf !== undefined).map((p) => p.revertOf));
  const good = prs.filter((p) => p.mergedAt && !isRevert(p) && !reverted.has(p.number));

  const self = issues.filter((i) => i.labels.includes('rt:self') && !/^Parent: #\d+/m.test(i.body));
  const cohort6 = self.filter((i) => inW(Date.parse(i.createdAt)));
  const cohort = cohort6.filter((i) => Date.parse(i.createdAt) <= now - DAY);

  const target = (i) => /^Bench: ([ULID]\d) /m.exec(i.body)?.[1];
  const targeted = cohort6.filter((i) => lowestIds.includes(target(i)));
  const l6 = (100 * targeted.length) / cohort6.length;

  const completed = cohort.filter((i) => good.some((p) => p.closes.includes(i.number)));
  const l7 = (100 * completed.length) / cohort.length;

  const invalid = cohort.filter((i) => i.closedAt && (i.stateReason === 'not_planned' || i.labels.includes('duplicate') || i.labels.includes('invalid')));
  const l8 = (100 * invalid.length) / cohort.length;

  return [
    result({ id: 'L6', value: l6, level: Math.min(up(l6, [20, 40, 60, 80, 100]), cohort6.length >= 5 ? 5 : 4), now, start, asOf: S.asOf, evidence: targeted, ok: cohort6.length > 0 }),
    result({ id: 'L7', value: l7, level: Math.min(up(l7, [20, 40, 55, 70, 80]), cohort.length >= 5 ? 5 : 4), now, start, asOf: S.asOf, evidence: completed, ok: cohort.length > 0 }),
    result({ id: 'L8', value: l8, level: Math.min(down(l8, [20, 10, 5, 2, 0]), cohort.length >= 5 ? 5 : 4), now, start, asOf: S.asOf, evidence: invalid, ok: cohort.length > 0 }),
  ];
}
