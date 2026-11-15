// Durable outbox: every side effect is enqueued as an item (append-only JSON lines) before any provider call,
// then delivered by dispatch, which records a receipt per delivered item.
// Provider contract: deliver({ id, kind, issue, payload }) must be idempotent by item id. dispatch may call it
// again for the same id after a lost acknowledgement, and the provider must not apply the side effect twice.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const OUTBOX_PATH = '.roundtable/state/outbox.jsonl';
export const KINDS = ['comment', 'label', 'merge', 'notification'];
export const OUTCOMES = ['send', 'do-not-send', 'suspend'];

// Notice ids derive from the cause, so a replayed cycle enqueues the same notice id and `enqueue` refuses it.
export function noticeId(cause) {
  if (cause.kind === 'merge') return `notice:merge:${cause.pr}:${cause.head}`;
  if (cause.kind === 'action') return `notice:action:${cause.actionId}:${cause.state}`;
  throw new TypeError(`unknown notice cause: ${cause.kind}`);
}

export function decideTurn({ wantsSideEffect, needsApproval, approved }) {
  if (!wantsSideEffect) return 'do-not-send';
  if (needsApproval && !approved) return 'suspend';
  return 'send';
}

function validate(item) {
  if (typeof item.id !== 'string' || item.id.length === 0) throw new TypeError('id must be a non-empty string');
  if (!KINDS.includes(item.kind)) throw new TypeError(`invalid kind: ${item.kind}`);
  if (item.issue !== null && !(Number.isInteger(item.issue) && item.issue > 0)) {
    throw new TypeError('issue must be a positive integer or null');
  }
  if (typeof item.payload !== 'object' || item.payload === null) throw new TypeError('payload must be an object');
}

export function openOutbox(root) {
  const file = join(root, OUTBOX_PATH);
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const items = [];
  const receipts = new Map();
  const failures = new Map(); // item id -> timestamps of its failure records
  const dead = new Set();
  const seen = new Set();
  for (const line of lines) {
    if (line.type === 'item') {
      items.push(line.item);
      seen.add(line.item.id);
    } else if (line.type === 'receipt') {
      receipts.set(line.id, line.receipt);
    } else if (line.type === 'failure') {
      failures.set(line.id, [...(failures.get(line.id) ?? []), line.at]);
    } else if (line.type === 'dead') {
      dead.add(line.id);
    }
  }
  const append = (line) => {
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, JSON.stringify(line) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  return {
    enqueue(item) {
      validate(item);
      if (seen.has(item.id)) return false;
      const stored = { id: item.id, kind: item.kind, issue: item.issue, payload: item.payload };
      append({ type: 'item', item: stored });
      seen.add(stored.id);
      items.push(stored);
      return true;
    },
    items: () => items.map((i) => ({ ...i })),
    pending: () => items.filter((i) => !receipts.has(i.id) && !dead.has(i.id)).map((i) => ({ ...i })),
    // Map from item id to the receipt the provider returned for it.
    receipts: () => new Map(receipts),
    markDelivered(id, receipt) {
      append({ type: 'receipt', id, receipt });
      receipts.set(id, receipt);
    },
    recordFailure(id, message, at) {
      append({ type: 'failure', id, message, at });
      failures.set(id, [...(failures.get(id) ?? []), at]);
    },
    // Timestamps of the failure records of an item, oldest first.
    failures: (id) => [...(failures.get(id) ?? [])],
    markDead(id) {
      append({ type: 'dead', id });
      dead.add(id);
    },
  };
}

// With backoffMs, an item whose last failure is newer than backoffMs * 2^(failures-1) is skipped, and a failed item
// gets one attempt per cycle. With deadAfter, the item is marked dead after that many total failures and a
// stall-alert notification is enqueued (never for a stall alert itself, which would alert forever).
export async function dispatch({ outbox, provider, maxAttempts = 3, now = Date.now, backoffMs, deadAfter }) {
  const delivered = [];
  const failed = [];
  for (const item of outbox.pending()) {
    const past = outbox.failures(item.id);
    if (backoffMs !== undefined && past.length > 0 && now() - past.at(-1) < backoffMs * 2 ** (past.length - 1)) continue;
    let done = false;
    for (let attempt = 0; attempt < maxAttempts && !done; attempt++) {
      try {
        outbox.markDelivered(item.id, await provider.deliver({ ...item }));
        done = true;
      } catch (error) {
        outbox.recordFailure(item.id, error.message, now());
        if (deadAfter !== undefined && outbox.failures(item.id).length >= deadAfter) {
          outbox.markDead(item.id);
          if (item.payload.subtype !== 'stall-alert') {
            outbox.enqueue({ id: `alert:dead:${item.id}`, kind: 'notification', issue: item.issue, payload: { subtype: 'stall-alert', of: item.id } });
          }
          break;
        }
        if (backoffMs !== undefined) break;
      }
    }
    (done ? delivered : failed).push(item.id);
  }
  return { delivered, failed };
}
