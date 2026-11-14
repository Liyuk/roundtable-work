// Layered role memory. Layer 1: per-task records (never preloaded). Layer 2: per-role repo knowledge,
// written by reflect(). Layer 3: stable rules promoted from a layer-2 cue that recurs.
// Rules: a session preloads active layer-3 rules, then a one-line layer-2 index, cut at a char cap.
// Full entries are fetched on demand and each fetch is logged. Layer 2 keeps the newest `layer2`
// entries and layer 3 the newest `layer3` (oldest pruned first). A cue seen `promoteAfter` times
// is promoted once; rollback marks the rule rolled_back, which stops preloading and blocks re-promotion.
// Store contract: save/get/update/remove/list (insertion order). Log: append(entry).

export const LIMITS = Object.freeze({ preloadChars: 2000, layer2: 30, layer3: 20, promoteAfter: 3 });

const rowsOf = (store, layer, role) => store.list().filter((r) => r.layer === layer && r.role === role);
const cueKey = (cue) => cue.trim().toLowerCase();

/** Preload for a new role session: active layer-3 rules, then layer-2 index lines, under `cap` chars. */
export function preload({ store, role, cap = LIMITS.preloadChars }) {
  const rules = rowsOf(store, 3, role).filter((r) => r.status !== 'rolled_back').map((r) => `L3 ${r.id}: ${r.lesson}`);
  const index = rowsOf(store, 2, role).map((r) => `L2 ${r.id}: ${r.cue}`);
  const lines = [];
  let size = 0;
  for (const line of [...rules, ...index]) {
    if (size + line.length + 1 > cap) break;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join('\n');
}

/** On-demand fetch of one full entry; every fetch is logged. */
export function fetchEntry({ store, log, layer, id }) {
  log.append({ layer, id });
  return store.get(id);
}

/** Promote each layer-2 cue seen `threshold` times to one layer-3 rule; returns the new rule ids. */
export function promote({ store, role, threshold = LIMITS.promoteAfter }) {
  const groups = new Map();
  for (const r of rowsOf(store, 2, role)) groups.set(cueKey(r.cue), [...(groups.get(cueKey(r.cue)) ?? []), r]);
  const seen = new Set(rowsOf(store, 3, role).map((r) => r.cueKey));
  const promoted = [];
  for (const [key, rows] of groups) {
    if (rows.length < threshold || seen.has(key)) continue;
    const rule = { layer: 3, role, id: `rule:${role}:${key}`, cueKey: key, lesson: rows[0].lesson, from: rows.map((r) => r.id), status: 'active' };
    store.save(rule);
    promoted.push(rule.id);
  }
  return promoted;
}

/** Roll back a promoted rule: it stops preloading and its cue is not promoted again. */
export function rollback({ store, id }) {
  store.update(id, { status: 'rolled_back' });
  return { status: 'rolled_back' };
}

/** Drop the oldest entries beyond each layer's cap. */
export function prune({ store, role }) {
  for (const [layer, limit] of [[2, LIMITS.layer2], [3, LIMITS.layer3]]) {
    const rows = rowsOf(store, layer, role);
    for (const r of rows.slice(0, Math.max(0, rows.length - limit))) store.remove(r.id);
  }
}
