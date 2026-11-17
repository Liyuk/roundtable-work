// rt-bench D1-D5 (docs/autonomy-benchmark.md section 6). Pure: `now` is passed in; no clock, no I/O.
// Same window, productionStart, result shape and not-measurable rule as metrics-li.mjs.
// Sources are normalized; each is { asOf (epoch ms), ... } and a missing or stale source gives level 0, not measurable:
//   interventions: { asOf, events: [{ at, kind, ref }] }                                    D1
//   waits:         { asOf, spans: [{ issue, label, startedAt, endedAt | null, redLine }] }  D2
//   decisions:     { asOf, events: [{ at, verdict }] }                                     D3
//   merges:        { asOf, events: [{ at, pr, by: 'loop' | 'human' | 'bot', revertOf? }] } D4, D5
// Decisions:
// - D3 counts resolve, ask-owner, stop and invalid only; fallback and timeout-default are not counted.
// - Revert PR = event with revertOf. The reverted set is every revertOf, in or out of W. Reverts and reverted PRs leave the good merges.
// - D4 level is capped at 4 below 20 loop merges (n >= 20 rule for L5).
import { measure } from './score.mjs';
import { PRODUCTION_START } from './metrics-u.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WINDOW = 7 * DAY;

const t = (e, key = 'at') => Date.parse(e[key]);
const iso = (ms) => new Date(ms).toISOString();
// Ascending bands: the level is the number of cutoffs reached.
const up = (value, cuts) => cuts.filter((c) => value >= c).length;
// Descending bands: the level is the number of cutoffs the value is at or under.
const down = (value, cuts) => cuts.filter((c) => value <= c).length;

function result({ id, name, value, level, now, start, src, evidence, ok = true, why = '' }) {
  const m = measure({ id, level: ok ? level : 0, source: { asOf: src.asOf } }, now);
  const measurable = m.measurable && ok;
  return {
    id,
    value,
    level: m.level,
    window: { start: iso(start), end: iso(now) },
    source: m.source,
    measurable,
    evidence: measurable ? evidence : [{ reason: m.measurable ? why : `${name} source missing or stale` }],
  };
}

export function computeD({ now, productionStart = PRODUCTION_START, sources = {} }) {
  const S = { interventions: {}, waits: {}, decisions: {}, merges: {}, ...sources };
  const start = Math.max(now - WINDOW, productionStart);
  const W = (events = [], key = 'at') => events.filter((e) => t(e, key) >= start && t(e, key) <= now);

  // D1: human decisions and terminal merges or closes in W.
  const d1Events = W(S.interventions.events).filter((e) => ['decision', 'decide', 'merge', 'close'].includes(e.kind));
  const d1 = d1Events.length;

  // D2: longest non-red-line wait, clipped to W; an open wait runs to NOW.
  const spans = (S.waits.spans ?? []).filter((s) => !s.redLine);
  const waitHours = (s) => Math.max(0, Math.min(s.endedAt ? t(s, 'endedAt') : now, now) - Math.max(t(s, 'startedAt'), start)) / HOUR;
  const d2 = Math.max(0, ...spans.map(waitHours));

  // D3: share of resolved answers among resolve, ask-owner, stop and invalid.
  const decided = W(S.decisions.events).filter((e) => ['resolve', 'ask-owner', 'stop', 'invalid'].includes(e.verdict));
  const resolved = decided.filter((e) => e.verdict === 'resolve').length;
  const d3 = decided.length ? (100 * resolved) / decided.length : null;

  // D4-D5: reverts and their targets leave the good set; D4 counts revert PRs merged in W over loop merges.
  const all = S.merges.events ?? [];
  const reverted = new Set(all.filter((e) => e.revertOf !== undefined).map((e) => e.revertOf));
  const good = W(all).filter((e) => e.revertOf === undefined && !reverted.has(e.pr));
  const reverts = W(all).filter((e) => e.revertOf !== undefined);
  const loop = good.filter((e) => e.by === 'loop');
  const human = good.filter((e) => e.by === 'human');
  const d4 = loop.length ? (100 * reverts.length) / loop.length : null;
  const d5 = loop.length + human.length ? (100 * loop.length) / (loop.length + human.length) : null;

  return [
    result({ id: 'D1', name: 'interventions', value: d1, level: down(d1, [12, 6, 3, 1, 0]), now, start, src: S.interventions, evidence: d1Events }),
    result({ id: 'D2', name: 'waits', value: d2, level: down(d2, [96, 48, 24, 12, 4]), now, start, src: S.waits, evidence: spans }),
    result({ id: 'D3', name: 'decisions', value: d3, level: up(d3, [60, 80, 90, 95, 98]), now, start, src: S.decisions, evidence: decided, ok: decided.length > 0, why: 'no counted decisions in window' }),
    result({
      id: 'D4',
      name: 'merges',
      value: d4,
      level: Math.min(down(d4, [15, 10, 6, 4, 2]), loop.length >= 20 ? 5 : 4),
      now,
      start,
      src: S.merges,
      evidence: reverts,
      ok: loop.length > 0,
      why: 'no loop merges in window',
    }),
    result({ id: 'D5', name: 'merges', value: d5, level: up(d5, [70, 85, 93, 97, 100]), now, start, src: S.merges, evidence: [...loop, ...human], ok: loop.length + human.length > 0, why: 'no loop or human merges in window' }),
  ];
}
