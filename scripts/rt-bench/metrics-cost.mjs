// rt-bench C1-C3 cost efficiency (docs/autonomy-benchmark.md section 11). Pure: `now` is passed in; no clock, no I/O.
// Sources are normalized; each is { asOf (epoch ms), events }:
//   github:        { asOf, prs: [{ number, title, mergedAt, closes: [issue numbers], revertOf }] }         C1, C2
//   usage:         { asOf, events: [{ at, issue, inTok, outTok, parseOk, cost? }] }                      C1-C3
//   queueSnapshot: { asOf, events: [{ at, running, claimable }] }                                         C3
// Decisions:
// - Completed issue in W = named in `closes` of a non-revert PR merged in W (revert test as in metrics-q.mjs).
// - A usage row is reliable when parseOk === true and inTok and outTok are finite; C2 and C3 also need a finite cost.
// - C1 = (inTok + outTok of the usage rows of completed issues) / completed issues. Rows are not filtered by `at`.
// - C2 = the same over cost.
// - C3 = tokens of usage rows with `at` in W that fall in an idle interval. A snapshot with running = 0 and claimable = 0
//   starts an idle interval up to the next snapshot; rows before the first or after the last snapshot are not covered.
// - C1 and C2 are not measurable while a completed issue has no usage row, or any of its rows is not reliable.
//   C3 is not measurable while no usage row in W is covered, or any idle row is not reliable.
// - Not measurable (missing or stale source, empty cohort, unreliable data): measurable false, level 0, value null.
// - Level caps: C1 and C2 at 4 when the cohort is below 20 completed issues. C3 has no cap.
import { measure } from './score.mjs';
import { PRODUCTION_START } from './metrics-u.mjs';

const DAY = 24 * 60 * 60 * 1000;
const WINDOW = 7 * DAY;

const t = (e, key = 'at') => Date.parse(e[key]);
const iso = (ms) => new Date(ms).toISOString();
// Descending bands: the level is the number of cutoffs the value is at or under.
const down = (value, cuts) => cuts.filter((c) => value <= c).length;
const oldest = (...asOfs) => (asOfs.every(Number.isFinite) ? Math.min(...asOfs) : undefined);
const tokens = (r) => r.inTok + r.outTok;
const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);
const reliable = (r, needCost) => r.parseOk === true && Number.isFinite(r.inTok) && Number.isFinite(r.outTok) && (!needCost || Number.isFinite(r.cost));

function result({ id, value, level, start, now, asOf, evidence, ok = true }) {
  const m = measure({ id, level: ok ? level : 0, source: { asOf } }, now);
  return { id, value: m.measurable && ok ? value : null, level: m.level, window: { start: iso(start), end: iso(now) }, source: m.source, measurable: m.measurable && ok, evidence };
}

export function computeC({ now, productionStart = PRODUCTION_START, sources = {} }) {
  const S = { github: {}, usage: {}, queueSnapshot: {}, ...sources };
  const prs = S.github.prs ?? [];
  const usage = S.usage.events ?? [];
  const queue = [...(S.queueSnapshot.events ?? [])].sort((a, b) => t(a) - t(b));
  const start = Math.max(now - WINDOW, productionStart);
  const inW = (ms) => ms >= start && ms <= now;

  // C1 and C2: usage of the issues completed in W.
  const isRevert = (p) => p.revertOf !== undefined || /^Revert/.test(p.title);
  const completed = new Set(prs.filter((p) => p.mergedAt && !isRevert(p) && inW(t(p, 'mergedAt'))).flatMap((p) => p.closes));
  const attributed = usage.filter((r) => completed.has(r.issue));
  const hasUsage = completed.size > 0 && new Set(attributed.map((r) => r.issue)).size === completed.size;
  const cap = completed.size >= 20 ? 5 : 4;
  const issues = [...completed].map((issue) => ({ issue }));
  const c1 = sum(attributed, tokens) / completed.size;
  const c1Result = result({
    id: 'C1', value: c1, level: Math.min(down(c1, [2e6, 1e6, 5e5, 2.5e5, 1e5]), cap), start, now, asOf: oldest(S.github.asOf, S.usage.asOf),
    evidence: issues, ok: hasUsage && attributed.every((r) => reliable(r, false)),
  });
  const c2 = sum(attributed, (r) => r.cost) / completed.size;
  const c2Result = result({
    id: 'C2', value: c2, level: Math.min(down(c2, [5, 2, 1, 0.5, 0.2]), cap), start, now, asOf: oldest(S.github.asOf, S.usage.asOf),
    evidence: issues, ok: hasUsage && attributed.every((r) => reliable(r, true)),
  });

  // C3: usage in idle intervals of the queue snapshots.
  const interval = (ms) => {
    const i = queue.findLastIndex((s) => t(s) <= ms);
    return i >= 0 && i + 1 < queue.length ? queue[i] : null;
  };
  const covered = usage.filter((r) => inW(t(r)) && interval(t(r)) !== null);
  const idle = covered.filter((r) => interval(t(r)).running === 0 && interval(t(r)).claimable === 0);
  const c3 = sum(idle, tokens);
  const c3Result = result({
    id: 'C3', value: c3, level: down(c3, [1e6, 5e5, 2e5, 5e4, 1e4]), start, now, asOf: oldest(S.usage.asOf, S.queueSnapshot.asOf),
    evidence: idle.map((r) => ({ at: r.at, issue: r.issue, tokens: tokens(r) })), ok: covered.length > 0 && idle.every((r) => reliable(r, true)),
  });

  return [c1Result, c2Result, c3Result];
}
