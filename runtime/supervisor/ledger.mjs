// Append-only supervisor decision ledger. `append(line)` is injected; record() never reads or rewrites the file.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const LEDGER_PATH = '.roundtable/state/supervisor-ledger.jsonl';

const isText = (v) => typeof v === 'string' && v.length > 0;

export function createLedger({ append, newId = randomUUID, now = Date.now }) {
  return {
    record(entry) {
      if (!['observe', 'apply'].includes(entry.mode)) throw new TypeError(`invalid mode: ${entry.mode}`);
      for (const field of ['action', 'reason', 'findingSignature']) {
        if (!isText(entry[field])) throw new TypeError(`${field} must be a non-empty string`);
      }
      const stored = {
        id: newId(), traceId: entry.traceId ?? newId(), parentId: entry.parentId ?? null, at: now(),
        mode: entry.mode, action: entry.action, reason: entry.reason, findingSignature: entry.findingSignature,
      };
      append(JSON.stringify(stored) + '\n');
      return stored;
    },
  };
}

export const fileAppender = (file) => (line) => appendFileSync(file, line, { flag: 'a' });

export const parseLedger = (text) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
