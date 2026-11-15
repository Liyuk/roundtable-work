// Scheduler liveness: bounded inter-cycle wait, host-freeze vs scheduler-stall classification,
// a freeze ledger, and an adaptive worker cap. Pure: clocks, sleep and the ledger store are injected.
export const GAP_FACTOR = 3; // a cycle gap longer than 3x the poll interval is a gap
export const FREEZE_THRESHOLD = 3; // freezes in one window before the cap drops
export const FREEZE_WINDOW_MS = 6 * 3600e3; // rolling window and freeze-free recovery period

/** Sleep for the poll interval; ends as soon as either wall or monotonic time has covered it. */
export async function boundedWait({ pollMs, sleep, wall = Date.now, mono = () => performance.now() }) {
  const w0 = wall(), m0 = mono();
  const elapsed = () => Math.max(wall() - w0, mono() - m0);
  while (pollMs - elapsed() > 0) await sleep(pollMs - elapsed());
  return { wallMs: wall() - w0, monoMs: mono() - m0 };
}

/** @returns {'host-freeze'|'scheduler-stall'|null} null when the gap is not longer than GAP_FACTOR x poll. */
export function classifyGap({ gapMs, wallDeltaMs, monoDeltaMs, pollMs }) {
  if (gapMs <= GAP_FACTOR * pollMs) return null;
  return wallDeltaMs - monoDeltaMs > pollMs ? 'host-freeze' : 'scheduler-stall';
}

/** In-memory store for tests and callers that persist elsewhere: { load(), save(entries) }. */
export const memoryStore = (initial = []) => {
  let entries = initial;
  return { load: () => entries, save: (next) => { entries = next; } };
};

/** Freeze ledger over an injected store. Entries: { start, end, class }. */
export function createFreezeLedger({ store = memoryStore() } = {}) {
  let entries = store.load();
  return {
    append(entry) { entries = [...entries, entry]; store.save(entries); return entry; },
    all: () => entries,
    inWindow: (now, windowMs) => entries.filter((e) => e.end >= now - windowMs),
  };
}

/** Classify one cycle gap and append it to the ledger; returns the entry, or null for a normal gap. */
export function recordCycleGap({ ledger, pollMs, start, end, wallDeltaMs, monoDeltaMs }) {
  const cls = classifyGap({ gapMs: end - start, wallDeltaMs, monoDeltaMs, pollMs });
  return cls && ledger.append({ start, end, class: cls });
}

/** Per-line progress must not be charged for these intervals: { start, end } per ledger entry. */
export const excludedIntervals = (ledger) => ledger.all().map(({ start, end }) => ({ start, end }));

/** Mutable cap state; pass the same object to every effectiveCap call. */
export const createCapState = (base) => ({ cap: base, seen: 0, quietSince: -Infinity });

/** Adaptive worker cap: one step down per new freeze once the window holds `threshold`; one step up per freeze-free window. */
export function effectiveCap({ base, floor = 1, ledger, now, threshold = FREEZE_THRESHOLD, windowMs = FREEZE_WINDOW_MS, state, log = () => {} }) {
  const all = ledger.all();
  const fresh = all.length > state.seen;
  const before = state.cap;
  state.seen = all.length;
  if (fresh && ledger.inWindow(now, windowMs).length >= threshold) {
    state.cap = Math.max(floor, state.cap - 1);
  } else if (state.cap < base && now - Math.max(state.quietSince, all.at(-1)?.end ?? -Infinity) >= windowMs) {
    state.cap += 1;
    state.quietSince = now;
  }
  if (state.cap !== before) log({ at: now, from: before, to: state.cap, reason: fresh ? 'freeze' : 'recovered' });
  return state.cap;
}
