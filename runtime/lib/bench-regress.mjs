// rt-bench regression detection (docs/autonomy-benchmark.md section 8). Pure: rows are data, no clock, no I/O.

const score = (row, dim) => ({ value: row.dimensions[dim], level: row.dimensions[dim] });

/**
 * Pure: regression proposals from the two latest snapshot rows (oldest first), as { fingerprint, priority, key, title, line, snapshots }.
 * A sub-metric regression (level lower, or measurable turned false) is `bench:<ID>`: p1 when its dimension dropped, else p2.
 * A dimension, or the overall, drop with no sub-metric regression in it is `bench:<dim>` / `bench:overall`, p1.
 */
export function benchRegressions(rows) {
  if (rows.length < 2) return [];
  const [prev, last] = rows.slice(-2);
  const dropped = (dim) => last.dimensions[dim] < prev.dimensions[dim];
  const subs = Object.keys(last.ids).filter((id) => last.ids[id].level < prev.ids[id].level || (prev.ids[id].measurable && !last.ids[id].measurable));
  const proposal = (key, priority, now, was) => ({
    fingerprint: `bench:${key}`, priority, key, title: `Bench regression: ${key}`,
    line: `Bench: ${key} ${now.value} -> ${was.value} (level ${now.level} -> ${was.level}) within 7 d`,
    snapshots: [prev.at, last.at],
  });
  const subProposals = subs.map((id) => proposal(id, dropped(id[0]) ? 'p1' : 'p2', last.ids[id], prev.ids[id]));
  const dimProposals = ['U', 'L', 'I', 'D'].filter((dim) => dropped(dim) && !subs.some((id) => id[0] === dim))
    .map((dim) => proposal(dim, 'p1', score(last, dim), score(prev, dim)));
  const overall = dropped('overall') && !subs.length ? [proposal('overall', 'p1', score(last, 'overall'), score(prev, 'overall'))] : [];
  return [...subProposals, ...dimProposals, ...overall];
}
