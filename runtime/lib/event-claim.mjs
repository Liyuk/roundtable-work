// Event claims: at-most-one active worker per event (durable claim files), applied/ack markers, and coalescing of pending events.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ACKED_PATH, openInbox, sessionOf } from './event-inbox.mjs';
import { pidAlive } from './lock.mjs';

const STATE = '.roundtable/state';
const CLAIM_DIR = join(STATE, 'claims');
const APPLIED = join(STATE, 'applied.jsonl');
const ACKED = ACKED_PATH;

function appendDurable(file, line) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file, 'a');
  try { writeSync(fd, line + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

function readIds(file) {
  return new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
}

// Claim file content is the owner pid. It is linked into place whole, so a reader never sees an empty claim.
export function openClaims(root) {
  const dir = join(root, CLAIM_DIR);
  const pathOf = (key) => join(dir, createHash('sha256').update(key).digest('hex'));
  return {
    claim(key) {
      mkdirSync(dir, { recursive: true });
      const file = pathOf(key);
      const tmp = `${file}.${randomUUID()}`;
      writeFileDurable(tmp, String(process.pid));
      try {
        for (;;) {
          try {
            linkSync(tmp, file);
            return 'claimed';
          } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            if (pidAlive(Number(readFileSync(file, 'utf8')))) return 'already_claimed';
            unlinkSync(file); // holder died before applying: its claim is stale
          }
        }
      } finally {
        unlinkSync(tmp);
      }
    },
    release(key) {
      unlinkSync(pathOf(key));
    },
  };
}

function writeFileDurable(file, text) {
  const fd = openSync(file, 'wx');
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

export function markApplied(root, id) {
  appendDurable(join(root, APPLIED), id);
}

// Pending events with the same session form one batch; first-seen order is kept. Events with session none stay apart.
export function coalesce(events) {
  const groups = new Map();
  for (const e of events) {
    const session = e.session ?? sessionOf(e);
    const key = session === 'none' ? e : session;
    if (!groups.has(key)) groups.set(key, { kind: e.kind, issue: e.issue, events: [] });
    groups.get(key).events.push(e);
  }
  return [...groups.values()];
}

// Replays every event not yet acked. An event with an applied marker only needs its ack. Any other event is claimed
// and dispatched; if the previous holder died mid-dispatch its claim is stale and the event is dispatched again.
// Each batch event carries source_event_id. A consumer whose effect is keyed by source_event_id can make the effect
// idempotent; without that, a crash between the effect and the applied marker replays the effect once more.
export async function processPending(root, dispatch) {
  const applied = readIds(join(root, APPLIED));
  const acked = readIds(join(root, ACKED));
  const claims = openClaims(root);
  const inbox = openInbox(root);
  const todo = [];
  for (const e of inbox.events()) {
    const id = e.source_event_id;
    if (acked.has(id)) continue;
    if (applied.has(id)) {
      appendDurable(join(root, ACKED), id);
      inbox.setStatus(id, 'done');
    } else if (claims.claim(id) === 'claimed') {
      todo.push(e);
      inbox.setStatus(id, 'claimed');
    }
  }
  const finished = new Set();
  try {
    for (const batch of coalesce(todo)) {
      await dispatch(batch);
      for (const e of batch.events) {
        const id = e.source_event_id;
        markApplied(root, id);
        appendDurable(join(root, ACKED), id);
        inbox.setStatus(id, 'done');
        finished.add(id);
      }
    }
  } catch (err) {
    // Unfinished claims are released so the events are dispatched again on the next call.
    for (const e of todo) {
      if (finished.has(e.source_event_id)) continue;
      claims.release(e.source_event_id);
      inbox.setStatus(e.source_event_id, 'pending');
    }
    throw err;
  }
}
