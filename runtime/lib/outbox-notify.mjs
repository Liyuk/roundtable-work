// File sink for notification outbox items: one JSON line per item in <root>/.roundtable/state/outbox/notify.jsonl.
// Exports:
//   createNotifyFileProvider({ root, now })  outbox provider: deliver(item) appends one line; a repeated id returns the stored line
//   readAck(root)                            last consumed item id from notify.ack, or null
//   writeAck(root, id)                       records the last consumed item id
// No network call. Unknown pr/commit/recipient are null. The summary names only the subtype, issue and PR.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const NOTIFY_PATH = '.roundtable/state/outbox/notify.jsonl';
export const ACK_PATH = '.roundtable/state/outbox/notify.ack';

export function createNotifyFileProvider({ root, now = () => new Date().toISOString() }) {
  const file = join(root, NOTIFY_PATH);
  return {
    deliver(item) {
      const past = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
      const hit = past.find((record) => record.id === item.id);
      if (hit) return hit;
      const { subtype, pr = null, commit = item.payload.head ?? null, recipient = null } = item.payload;
      const record = {
        id: item.id,
        ts: now(),
        event: subtype,
        issue: item.issue,
        pr,
        commit,
        recipient,
        summary: `${subtype.replace(/-/g, ' ')}${pr === null ? '' : ` for PR #${pr}`}${item.issue === null ? '' : ` on issue #${item.issue}`}`,
      };
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(record) + '\n');
      return record;
    },
  };
}

export function readAck(root) {
  const file = join(root, ACK_PATH);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

export function writeAck(root, id) {
  const file = join(root, ACK_PATH);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, id + '\n');
}
