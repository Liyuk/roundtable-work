import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { assertSafeId } from './paths.mjs';

/** States the loop never picks up on its own (final, or waiting for a person / explicit recovery). */
export const TERMINAL_STATES = Object.freeze([
  'done', 'stop', 'out-of-scope', 'cancelled', 'failed', 'blocked', 'waiting_person', 'interrupted',
]);

export const isTerminal = (state) => TERMINAL_STATES.includes(state);

export const MAX_QUEUE_BYTES = 1024 * 1024;

/** Structurally malformed entries throw a TypeError (the caller skips them); an unsafe id still throws PathEscapeError. */
function normalize(entry, index) {
  const raw = typeof entry === 'object' && entry !== null && !Array.isArray(entry) ? entry : { id: entry };
  if (raw.id === undefined || raw.id === null || typeof raw.id === 'object') throw new TypeError(`Queue entry ${index} has no id`);
  const priority = raw.priority === undefined ? 0 : Number(raw.priority);
  if (!Number.isFinite(priority)) throw new TypeError(`Queue entry ${index} has a non-numeric priority`);
  if (raw.state !== undefined && typeof raw.state !== 'string') throw new TypeError(`Queue entry ${index} has a non-string state`);
  return { ...raw, id: assertSafeId(raw.id), priority, state: raw.state ?? 'queued', index };
}

/** Read a queue file without following a growing file past `maxBytes` (TypeError before any parse). */
async function readBounded(path, maxBytes) {
  const fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const { size } = await fh.stat();
    if (size > maxBytes) throw new TypeError(`Queue file is larger than ${maxBytes} bytes`);
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > maxBytes) throw new TypeError(`Queue file is larger than ${maxBytes} bytes`);
    return buf.toString('utf8', 0, bytesRead);
  } finally { await fh.close(); }
}

/**
 * Read a queue from an array, an (async) provider function, or a JSON file inside the work root.
 * Returns `{ items, skipped }`: items are runnable, ordered by priority (higher first), then input
 * order; the first occurrence of a duplicate id wins. Ids are compared case-insensitively because they become
 * file names (`Abc` and `abc` are one file on a case-insensitive filesystem). A structurally malformed entry
 * (no id, non-numeric priority, non-string state) is skipped with reason `invalid` and does not reject the
 * queue; an id that is not a safe file name still throws `PathEscapeError`. A queue file larger than
 * `maxBytes` (default 1 MiB) is a `TypeError`, nothing is parsed. The queue's `state` is advisory only: the
 * durable per-issue state always wins (a durable terminal state is never resurrected by the queue).
 * @param {Array|Function|string} source
 * @param {{ confinement?: object, maxBytes?: number, signal?: AbortSignal }} [options]
 */
export async function readQueue(source, { confinement, maxBytes = MAX_QUEUE_BYTES, signal } = {}) {
  let entries;
  if (typeof source === 'function') entries = await source({ signal });
  else if (typeof source === 'string') {
    if (!confinement) throw new TypeError('A file-backed queue needs a confinement');
    entries = JSON.parse(await confinement.withParent(source, (dir, name) => readBounded(`${dir}/${name}`, maxBytes)));
  } else entries = source;
  if (entries && !Array.isArray(entries) && Array.isArray(entries.issues)) entries = entries.issues;
  if (!Array.isArray(entries)) throw new TypeError('Queue must be an array (or an object with an "issues" array)');

  const seen = new Set();
  const items = [];
  const skipped = [];
  entries.forEach((entry, index) => {
    let item;
    try { item = normalize(entry, index); } catch (err) {
      if (err instanceof TypeError) { skipped.push({ index, reason: 'invalid', detail: err.message }); return; }
      throw err;
    }
    const key = item.id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (isTerminal(item.state)) skipped.push({ id: item.id, state: item.state, reason: 'terminal' });
    else items.push(item);
  });
  items.sort((a, b) => b.priority - a.priority || a.index - b.index);
  return { items, skipped };
}
