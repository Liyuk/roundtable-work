// Event inbox: every trigger becomes one event, de-duplicated by source_event_id and persisted as append-only JSON lines.
// Status changes and dropped duplicates are appended as further lines; records without a `type` are events.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const INBOX_PATH = '.roundtable/state/event-inbox.jsonl';
export const ACKED_PATH = '.roundtable/state/acked.jsonl';
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

// Session: the issue line, else the chat, else none. Events of one session are coalesced into one run.
export function sessionOf(event) {
  if (event.issue != null) return `issue:${event.issue}`;
  if (event.payload.chatId != null) return `chat:${event.payload.chatId}`;
  return 'none';
}

// One line from kind and payload; JSON.stringify escapes newlines, and the result is cut to 120 code points.
const whatOf = (event) => [...`${event.kind} ${JSON.stringify(event.payload)}`].slice(0, 120).join('');

export function openInbox(root, { onWrite = () => {} } = {}) {
  const file = join(root, INBOX_PATH);
  const events = [];
  const statuses = new Map();
  const seen = new Set();
  for (const line of existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []) {
    const record = JSON.parse(line);
    if (record.type === undefined) {
      events.push(record);
      seen.add(record.source_event_id);
    } else if (record.type === 'status') {
      statuses.set(record.id, record.status);
    }
  }
  const acked = new Set(existsSync(join(root, ACKED_PATH)) ? readFileSync(join(root, ACKED_PATH), 'utf8').split('\n').filter(Boolean) : []);
  const append = (record) => {
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, 'a');
    try {
      writeSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    onWrite();
  };
  return {
    events: () => [...events],
    statusOf: (id) => statuses.get(id) ?? (acked.has(id) ? 'done' : 'pending'),
    setStatus(id, status) {
      append({ type: 'status', id, status, at: Date.now() });
      statuses.set(id, status);
    },
    accept(event) {
      validate(event);
      if (seen.has(event.source_event_id)) {
        append({ type: 'dropped', original: event.source_event_id, at: Date.now() });
        return false;
      }
      const stored = {
        source_event_id: event.source_event_id, kind: event.kind, issue: event.issue,
        payload: event.payload, receivedAt: event.receivedAt,
        when: event.receivedAt, what: whatOf(event), session: sessionOf(event),
      };
      append(stored);
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
