// rt-bench U1-U6 (docs/autonomy-benchmark.md section 3). Pure: `now` is passed in; no clock, no I/O.
// Sources are normalized: each is { asOf (epoch ms), events: [{ at (UTC ISO), ... }] }.
import { measure } from './score.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW = 7 * DAY;
export const PRODUCTION_START = Date.parse('2026-11-11T08:00:00Z');

const t = (e) => Date.parse(e.at);
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

// Freeze (F) and pause (P) time are zero: no freeze or pause source is injected yet.
export function computeU({ now, productionStart = PRODUCTION_START, sources }) {
  const S = { interventions: {}, schedStarts: {}, schedGaps: {}, stages: {}, self: {}, ...sources };
  const start = Math.max(now - WINDOW, productionStart);
  const W = (events = [], from = start) => events.filter((e) => t(e) >= from && t(e) <= now).sort(byTime);
  const hours = (now - start) / HOUR;

  // U1: greedy episodes; an event within 30 min of the previous one joins its episode.
  const ivs = W(S.interventions.events);
  const episodes = ivs.filter((e, i) => i === 0 || t(e) - t(ivs[i - 1]) > 30 * MIN).length;
  const u1 = episodes ? hours / episodes : hours;

  // U2: longest gap between consecutive intervention instants, including both window edges.
  const times = [start, ...ivs.map(t), now];
  const u2 = Math.max(...times.slice(1).map((x, i) => x - times[i])) / HOUR;

  const manual = W(S.schedStarts.events).filter((e) => e.by === 'manual');

  // U4: a gap is recovered by a manual start or an intervention within 60 min after resumedAt.
  const gaps = W(S.schedGaps.events);
  const recoverers = [...manual, ...ivs];
  const unrecovered = gaps.filter((g) => !recoverers.some((e) => t(e) >= Date.parse(g.resumedAt) && t(e) <= Date.parse(g.resumedAt) + 60 * MIN));
  const u4 = gaps.length ? (100 * unrecovered.length) / gaps.length : null;

  const lost = W(S.stages.events).filter((e) => e.rc === 124 || e.rc === -15);

  // U6: 7 slices (NOW - 24(k+1) h, NOW - 24k h]; count those holding a self entry.
  const selfEv = W(S.self.events, now - WINDOW);
  const slices = Array.from({ length: 7 }, (_, k) => [now - DAY * (k + 1), now - DAY * k]);
  const u6 = slices.filter(([lo, hi]) => selfEv.some((e) => t(e) > lo && t(e) <= hi)).length;

  return [
    result({ id: 'U1', value: u1, level: up(u1, [2, 6, 12, 24, 72]), now, start, asOf: S.interventions.asOf, evidence: ivs }),
    result({ id: 'U2', value: u2, level: up(u2, [6, 12, 24, 48, 72]), now, start, asOf: S.interventions.asOf, evidence: ivs }),
    result({ id: 'U3', value: manual.length, level: down(manual.length, [14, 7, 3, 1, 0]), now, start, asOf: S.schedStarts.asOf, evidence: manual }),
    result({
      id: 'U4',
      value: u4,
      level: u4 === 100 && gaps.length >= 5 ? 5 : up(u4, [50, 70, 85, 95]),
      now,
      start,
      asOf: Math.min(S.schedGaps.asOf, S.schedStarts.asOf, S.interventions.asOf),
      evidence: gaps,
      ok: gaps.length > 0,
    }),
    result({ id: 'U5', value: lost.length, level: down(lost.length, [12, 6, 3, 1, 0]), now, start, asOf: S.stages.asOf, evidence: lost }),
    result({ id: 'U6', value: u6, level: up(u6, [1, 3, 5, 6, 7]), now, start: now - WINDOW, asOf: S.self.asOf, evidence: selfEv }),
  ];
}
