// GitHub polling fallback: conditional requests produce inbox events, and the inbox de-duplicates them against webhook
// deliveries, because both paths build source_event_id with sourceEventId().
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const POLL_STATE_PATH = '.roundtable/state/github-poll.json';
export const RECONCILE_MS = 15 * 60_000;
const MODES = ['webhook', 'poll', 'hybrid'];
const ACTIVE_MS = 10 * 60_000;
const FLOOR = 10;

const IDS = {
  issue: (p) => `gh-issue:${p.number}:${p.updatedAt}`,
  comment: (p) => `gh-comment:${p.id}`,
  check: (p) => `gh-check:${p.suite}:${p.conclusion}`,
};

/** Shared by daemon-events (the reader) and the poller: one observation, one id, whichever path saw it first. */
export const sourceEventId = (kind, parts) => IDS[kind](parts);

/** Persists `{ etags, cursor }` as JSON; written to a temp file and renamed, so a crash never leaves half a file. */
export function openPollStore(root) {
  const file = join(root, POLL_STATE_PATH);
  return {
    read: () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { etags: {}, cursor: null }),
    write(state) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(state));
      renameSync(`${file}.tmp`, file);
    },
  };
}

/**
 * Next poll delay. Fast (minMs) shortly after an event, doubling toward maxMs while idle; never sooner than
 * retryAfterMs; when the rate-limit budget is at the floor, waits until resetAt.
 */
export function nextIntervalMs({ currentMs, sinceEventMs, minMs, maxMs, remaining, resetAt, now, retryAfterMs = 0 }) {
  let ms = sinceEventMs < ACTIVE_MS ? minMs : Math.min(maxMs, currentMs * 2);
  if (remaining !== undefined && remaining <= FLOOR) ms = resetAt - now;
  return Math.max(ms, retryAfterMs, 0);
}

/** Pure: 'webhook' never polls; 'hybrid' polls only on the RECONCILE_MS cadence; 'poll' follows intervalMs. */
export function pollDue({ mode, lastPollAt, now, intervalMs }) {
  if (mode === 'webhook') return false;
  return now - lastPollAt >= (mode === 'hybrid' ? RECONCILE_MS : intervalMs);
}

/**
 * `request({ path, etag })` resolves `{ status, etag, headers: { remaining, resetAt, retryAfterMs }, body }`.
 * `toEvents(body)` maps a 200 body to inbox events. Only 200 is accepted: 304 and errors change nothing.
 */
export function createPoller({ request, store, inbox, toEvents, now = Date.now, minMs = 15_000, maxMs = RECONCILE_MS }) {
  let currentMs = minMs;
  let lastEventAt = now();
  return {
    async poll(path) {
      const state = store.read();
      const res = await request({ path, etag: state.etags[path] });
      const t = now();
      let accepted = 0;
      if (res.status === 200) {
        for (const event of toEvents(res.body)) if (inbox.accept({ ...event, receivedAt: t })) accepted++;
        store.write({ etags: { ...state.etags, [path]: res.etag }, cursor: t });
      }
      if (accepted > 0) lastEventAt = t;
      const { remaining, resetAt, retryAfterMs } = res.headers;
      currentMs = nextIntervalMs({ currentMs, sinceEventMs: t - lastEventAt, minMs, maxMs, remaining, resetAt, now: t, retryAfterMs });
      return { status: res.status, accepted, nextMs: currentMs };
    },
  };
}

/** 'webhook' | 'poll' | 'hybrid'. Without a listener there is no push source, so polling is the only option. */
export function resolveMode(configured, { listenerConfigured }) {
  if (configured !== undefined && !MODES.includes(configured)) throw new TypeError(`invalid mode: ${configured}`);
  if (!listenerConfigured || configured === 'poll') return 'poll';
  return configured ?? 'hybrid';
}
