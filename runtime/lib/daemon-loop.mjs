// Daemon cycle loop: each cycle records the gap since the previous cycle in a file-backed freeze ledger, runs one pass
// with an adaptive worker cap, writes the heartbeat and waits a bounded interval. Clocks, sleep and the pass are injected.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { GAP_FACTOR, boundedWait, createCapState, createFreezeLedger, effectiveCap, recordCycleGap } from './liveness.mjs';
import { HEARTBEAT_PATH, SCHEMA_VERSION, parseHeartbeat, writeHeartbeat } from '../supervisor/heartbeat.mjs';

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
 * Runs `pass({ workers })` once per cycle until `signal` aborts. Resolves 0 on abort, EXIT_CYCLE_DEADLINE when a pass
 * does not settle within `cycleDeadlineMs`. A throwing pass writes a stopped heartbeat and rethrows.
 */
export async function runLoop({ pass, pollMs, cycleDeadlineMs, workRoot, baseWorkers, wall = Date.now, mono = () => performance.now(), sleep = defaultSleep, signal }) {
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
      outcome = await Promise.race([pass({ workers: () => effectiveCap({ base: baseWorkers, ledger, now: wall(), state: cap }) }), deadline]);
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
    // Ends early when aborted; the pending boundedWait is then simply dropped.
    await Promise.race([boundedWait({ pollMs, sleep, wall, mono }), aborted]);
  }
  heartbeat('stopped', last?.wall ?? wall());
  return 0;
}
