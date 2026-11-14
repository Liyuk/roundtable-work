// Event timers: one-shot and recurring schedules kept apart from the event inbox. Each firing enqueues one inbox
// event whose source_event_id names the firing, so a replayed firing is de-duplicated by the inbox.
// Waits: a worker that decides `wait` writes a due timer and returns, which frees its slot and issue lock.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decide } from './machine.mjs';
import { openInbox } from './event-inbox.mjs';

export const TIMERS_PATH = '.roundtable/state/timers.json';

export function openTimers(root) {
  const file = join(root, TIMERS_PATH);
  const timers = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(timers));
    renameSync(`${file}.tmp`, file);
  };
  const put = (timer) => {
    const i = timers.findIndex((t) => t.id === timer.id);
    if (i === -1) timers.push(timer); else timers[i] = timer;
    save();
  };
  return {
    list: () => timers.map((t) => ({ ...t })),
    once: (timer) => put({ ...timer, kind: 'once', at: Date.parse(timer.at) }),
    recurring: (timer) => put({ ...timer, kind: 'recurring', at: Date.parse(timer.at) }),
    // Fires every timer due at `now` (epoch ms). Returns the number of inbox events accepted.
    fire(now) {
      const inbox = openInbox(root);
      let accepted = 0;
      for (const t of [...timers]) {
        while (t.at <= now) {
          const { id, at, event } = t;
          if (inbox.accept({ ...event, source_event_id: `timer:${id}:${at}`, receivedAt: now })) accepted++;
          if (t.kind === 'once') { timers.splice(timers.indexOf(t), 1); break; }
          t.at += t.cadenceMs;
        }
      }
      save();
      return accepted;
    },
  };
}

// Wait release: validates the wait decision and writes a due timer. The line resumes when the timer fires
// (inbox event) or when the awaited event (e.g. CI completion) reaches the inbox and is routed to the issue.
export function waitRelease(root, { issue, input }) {
  const decision = decide(input);
  openTimers(root).once({
    id: `wait:${issue}:${decision.event}`,
    at: decision.unblockAt,
    event: { kind: 'heartbeat', issue, payload: { wait: decision.event } },
  });
  return { timerId: `wait:${issue}:${decision.event}` };
}
