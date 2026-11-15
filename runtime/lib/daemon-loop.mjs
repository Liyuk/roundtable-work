// Daemon cycle loop: each cycle records the gap since the previous cycle in a file-backed freeze ledger, runs one pass
// with an adaptive worker cap, writes the heartbeat and waits a bounded interval. Clocks, sleep and the pass are injected.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { GAP_FACTOR, boundedWait, createCapState, createFreezeLedger, effectiveCap, recordCycleGap } from './liveness.mjs';
import { HEARTBEAT_PATH, SCHEMA_VERSION, parseHeartbeat, writeHeartbeat } from '../supervisor/heartbeat.mjs';
import { processPending } from './event-claim.mjs';
import { produceEvents } from './daemon-events.mjs';
import { recover } from './recovery.mjs';
import { openOutbox } from './outbox.mjs';

export const EXIT_CYCLE_DEADLINE = 77;
export const DEFAULT_POLL_MS = 300_000;
export const LEDGER_PATH = '.roundtable/state/freeze-ledger.jsonl';
/** The workspace root that contains `.roundtable/` for a work root ending in `.roundtable`; undefined otherwise. */
export const loopWorkspace = (workRoot) => (basename(resolve(workRoot)) === '.roundtable' ? dirname(resolve(workRoot)) : undefined);
const ERROR_CODE_POINTS = 300;
const DEADLINE = Symbol('cycle deadline');
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clip = (text, n) => Array.from(text).slice(0, n).join('');

/** Reads a state file; undefined when absent. */
const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/** Replaces the file atomically: write a temp file in the same directory, then rename it over the target. */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Sync store for createFreezeLedger. Lines that are not JSON or not ledger entries are skipped. */
export function fileLedgerStore(file) {
  return {
    load: () => (readText(file) ?? '').split('\n').flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return Number.isFinite(entry?.start) && Number.isFinite(entry?.end) && typeof entry.class === 'string' ? [entry] : [];
      } catch {
        return [];
      }
    }),
    save: (entries) => writeAtomic(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')),
  };
}

/** Pure verdict for the report-only watchdog: 0 when fresh or covered by the last host-freeze, otherwise 3. */
export function watchdogVerdict({ heartbeat, ledgerEntries, now, pollMs }) {
  if (!heartbeat.ok) return { exit: 3, reason: heartbeat.reason };
  const { lastCycleAt } = heartbeat.value.daemon;
  if (now - lastCycleAt <= GAP_FACTOR * pollMs) return { exit: 0, reason: 'fresh' };
  const last = ledgerEntries.at(-1);
  if (last?.class === 'host-freeze' && last.end >= lastCycleAt) return { exit: 0, reason: 'host-freeze' };
  return { exit: 3, reason: 'stale' };
}

/**
 * Runs `pass({ workers })` once per cycle until `signal` aborts. Each cycle first runs `prune()`, then `budget()`: when the
 * budget resolves false the pass is not started, so no new line is admitted while the running ones finish in their own pass.
 * Resolves 0 on abort, EXIT_CYCLE_DEADLINE when a pass does not settle within `cycleDeadlineMs`. A throwing pass writes a
 * stopped heartbeat and rethrows.
 */
export async function runLoop({ pass, pollMs, cycleDeadlineMs, workRoot, baseWorkers, wall = Date.now, mono = () => performance.now(), sleep = defaultSleep, signal, wake, prune, budget }) {
  const ledger = createFreezeLedger({ store: fileLedgerStore(join(workRoot, LEDGER_PATH)) });
  const cap = createCapState(baseWorkers);
  const aborted = new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }));

  const heartbeat = (state, lastCycleAt, error) => {
    const prior = parseHeartbeat(readText(join(workRoot, HEARTBEAT_PATH)));
    const kept = prior.ok ? prior.value : {};
    writeHeartbeat({
      schemaVersion: SCHEMA_VERSION,
      writtenAt: wall(),
      daemon: { pid: process.pid, lastCycleAt, state, ...(error !== undefined && { error: clip(String(error?.message ?? error), ERROR_CODE_POINTS) }) },
      frontChief: kept.frontChief ?? { session: 'none', lastTurnAt: 0, state: 'gone' },
      lastMaterialProgress: kept.lastMaterialProgress ?? null,
    }, { write: (path, text) => writeAtomic(join(workRoot, path), text) });
  };

  let last = null;
  while (!signal?.aborted) {
    const start = wall(), m0 = mono();
    if (last) recordCycleGap({ ledger, pollMs, start: last.wall, end: start, wallDeltaMs: start - last.wall, monoDeltaMs: m0 - last.mono });
    last = { wall: start, mono: m0 };

    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(DEADLINE), cycleDeadlineMs); });
    let outcome;
    try {
      const cycle = async () => {
        if (prune) await prune();
        if (budget && !(await budget())) return null;
        return pass({ workers: () => effectiveCap({ base: baseWorkers, ledger, now: wall(), state: cap }) });
      };
      outcome = await Promise.race([cycle(), deadline]);
    } catch (error) {
      heartbeat('stopped', start, error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (outcome === DEADLINE) {
      heartbeat('stopped', start);
      return EXIT_CYCLE_DEADLINE;
    }
    heartbeat('running', start);
    // Ends early when aborted; the pending wait is then simply dropped. A wake signal replaces the bounded wait: its own
    // timer runs the poll, and an inbox write ends it early.
    await Promise.race([wake ? wake.wait(pollMs) : boundedWait({ pollMs, sleep, wall, mono }), aborted]);
  }
  heartbeat('stopped', last?.wall ?? wall());
  return 0;
}

/**
 * One inbox cycle: due timers fire, GitHub observations become events (when a reader is given), then each session's
 * pending events are dispatched once through `dispatchLine(batch)`. `now` is epoch ms.
 */
export async function cycleSteps({ root, inbox, timers, reader, since, now = Date.now(), dispatchLine }) {
  timers.fire(now);
  if (reader) await produceEvents({ inbox, reader, since });
  await processPending(root, async (batch) => {
    try {
      await dispatchLine(batch);
    } catch (error) {
      applyRecovery(root, timers, batch, error, now);
    }
  });
}

/** Applies the recovery table to a failed line: a `wait` writes a due timer, any other action enqueues a stall-alert. */
function applyRecovery(root, timers, batch, error, now) {
  const cls = error.failureClass ?? 'unknown';
  const result = recover({ class: cls, retryAfterMs: error.retryAfterMs }, { now });
  if (result.action === 'wait') {
    for (const e of batch.events) timers.once({ id: `recover:${cls}:${e.source_event_id}`, at: new Date(result.timer.at).toISOString(), event: { kind: e.kind, issue: e.issue, payload: e.payload } });
    return;
  }
  const first = batch.events[0].source_event_id;
  const issue = Number.isInteger(batch.issue) && batch.issue > 0 ? batch.issue : null;
  openOutbox(root).enqueue({ id: `notice:stall-alert:${cls}:${first}`, kind: 'notification', issue, payload: { subtype: 'stall-alert', class: cls, action: result.action, spendsBudget: result.spendsBudget } });
}
