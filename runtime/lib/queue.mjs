import { readFile } from 'node:fs/promises';
import { assertSafeId } from './paths.mjs';

/** States the loop never picks up on its own (final, or waiting for a person / explicit recovery). */
export const TERMINAL_STATES = Object.freeze([
  'done', 'stop', 'out-of-scope', 'cancelled', 'failed', 'blocked', 'waiting_person', 'interrupted',
]);

export const isTerminal = (state) => TERMINAL_STATES.includes(state);

function normalize(entry, index) {
  const raw = typeof entry === 'object' && entry !== null ? entry : { id: entry };
  if (raw.id === undefined || raw.id === null) throw new TypeError(`Queue entry ${index} has no id`);
  const priority = raw.priority === undefined ? 0 : Number(raw.priority);
  if (!Number.isFinite(priority)) throw new TypeError(`Queue entry ${index} has a non-numeric priority`);
  return { ...raw, id: assertSafeId(raw.id), priority, state: raw.state ?? 'queued', index };
}

/**
 * Read a queue from an array, an (async) provider function, or a JSON file inside the work root.
 * Returns `{ items, skipped }`: items are runnable, ordered by priority (higher first), then input
 * order; the first occurrence of a duplicate id wins.
 * @param {Array|Function|string} source
 * @param {{ confinement?: { resolve(p: string): Promise<string> } }} [options]
 */
export async function readQueue(source, { confinement } = {}) {
  let entries;
  if (typeof source === 'function') entries = await source();
  else if (typeof source === 'string') {
    if (!confinement) throw new TypeError('A file-backed queue needs a confinement');
    entries = JSON.parse(await readFile(await confinement.resolve(source), 'utf8'));
  } else entries = source;
  if (entries && !Array.isArray(entries) && Array.isArray(entries.issues)) entries = entries.issues;
  if (!Array.isArray(entries)) throw new TypeError('Queue must be an array (or an object with an "issues" array)');

  const seen = new Set();
  const items = [];
  const skipped = [];
  entries.map(normalize).forEach((item) => {
    if (seen.has(item.id)) return;
    seen.add(item.id);
    if (isTerminal(item.state)) skipped.push({ id: item.id, state: item.state, reason: 'terminal' });
    else items.push(item);
  });
  items.sort((a, b) => b.priority - a.priority || a.index - b.index);
  return { items, skipped };
}
