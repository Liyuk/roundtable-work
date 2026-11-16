// rt-bench scoring (docs/autonomy-benchmark.md section 7). Pure: no clock, no I/O.
// Staleness is judged against the `now` epoch-ms value passed in by the caller.

const DAY_MS = 24 * 60 * 60 * 1000;

// A sub-metric without a finite source timestamp, or with one older than 24 h, is not measurable at level 0.
export function measure({ id, level, source }, now) {
  const measurable = Number.isFinite(source?.asOf) && now - source.asOf <= DAY_MS;
  return { id, level: measurable ? level : 0, measurable, source };
}

export function dimensionScore(levels) {
  const mean = levels.reduce((sum, level) => sum + level, 0) / levels.length;
  return Math.min(Math.floor(mean), Math.min(...levels) + 1);
}

// Sub-metric ids start with their dimension letter (U, L, I, D).
export function score(results, now) {
  const scores = {};
  for (const dim of ['U', 'L', 'I', 'D']) {
    const levels = results.filter((r) => r.id[0] === dim).map((r) => measure(r, now).level);
    scores[dim] = dimensionScore(levels);
  }
  scores.overall = Math.min(scores.U, scores.L, scores.I, scores.D);
  return scores;
}
