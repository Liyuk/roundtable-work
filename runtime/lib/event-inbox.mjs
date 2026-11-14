// Event inbox: every trigger becomes one event, de-duplicated by source_event_id and persisted as append-only JSON lines.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const INBOX_PATH = '.roundtable/state/event-inbox.jsonl';
export const KINDS = ['heartbeat', 'ci', 'owner_comment', 'intake', 'webhook'];

function validate(event) {
  if (typeof event.source_event_id !== 'string' || event.source_event_id.length === 0) {
    throw new TypeError('source_event_id must be a non-empty string');
  }
  if (!KINDS.includes(event.kind)) throw new TypeError(`invalid kind: ${event.kind}`);
  if (event.issue !== null && !(Number.isInteger(event.issue) && event.issue > 0)) {
    throw new TypeError('issue must be a positive integer or null');
  }
  if (typeof event.payload !== 'object' || event.payload === null) throw new TypeError('payload must be an object');
  if (typeof event.receivedAt !== 'number') throw new TypeError('receivedAt must be a number');
}

export function openInbox(root) {
  const file = join(root, INBOX_PATH);
  const events = existsSync(file)
    ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const seen = new Set(events.map((e) => e.source_event_id));
  return {
    events: () => [...events],
    accept(event) {
      validate(event);
      if (seen.has(event.source_event_id)) return false;
      const stored = {
        source_event_id: event.source_event_id, kind: event.kind, issue: event.issue,
        payload: event.payload, receivedAt: event.receivedAt,
      };
      mkdirSync(dirname(file), { recursive: true });
      const fd = openSync(file, 'a');
      try {
        writeSync(fd, JSON.stringify(stored) + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      seen.add(stored.source_event_id);
      events.push(stored);
      return true;
    },
  };
}

// Pure: lineByIssue is a Map from issue number to line id. Events with no matching issue are returned as unmatched.
export function matchEvents(events, lineByIssue) {
  const routed = [];
  const unmatched = [];
  for (const e of events) {
    const line = lineByIssue.get(e.issue);
    if (line === undefined) unmatched.push(e);
    else routed.push({ source_event_id: e.source_event_id, line });
  }
  return { routed, unmatched };
}
