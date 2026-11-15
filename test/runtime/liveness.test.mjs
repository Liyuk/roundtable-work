import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedWait, classifyGap, createCapState, createFreezeLedger, effectiveCap, excludedIntervals, memoryStore, recordCycleGap } from '../../runtime/lib/liveness.mjs';
import { detectStalls } from '../../runtime/lib/stall.mjs';

const HOUR = 3600e3;
// Fake clock: wall and monotonic time are independent so a host freeze can advance wall time only.
function fakeClock() {
  let wall = 1_700_000_000_000, mono = 0;
  return {
    wall: () => wall,
    mono: () => mono,
    advance: (ms, monoMs = ms) => { wall += ms; mono += monoMs; },
  };
}

test('bounded wait never requests more than the poll interval and ends when either clock reaches it', async () => {
  const clock = fakeClock();
  const requests = [];
  const sleep = async (ms) => { requests.push(ms); clock.advance(ms); };
  const result = await boundedWait({ pollMs: 1000, sleep, wall: clock.wall, mono: clock.mono });
  assert.deepEqual(requests, [1000]);
  assert.deepEqual(result, { wallMs: 1000, monoMs: 1000 });

  // Wall clock jumps forward (host freeze): the wait still ends after the one sleep.
  const frozen = fakeClock();
  const frozenRequests = [];
  await boundedWait({ pollMs: 1000, sleep: async (ms) => { frozenRequests.push(ms); frozen.advance(ms, 0); frozen.advance(5 * HOUR, 0); }, wall: frozen.wall, mono: frozen.mono });
  assert.deepEqual(frozenRequests, [1000]);

  // Monotonic clock is slow: the wait keeps sleeping only for the remaining interval, never beyond it.
  const slow = fakeClock();
  const slowRequests = [];
  const slowResult = await boundedWait({ pollMs: 1000, sleep: async (ms) => { slowRequests.push(ms); slow.advance(Math.min(ms, 400), Math.min(ms, 400)); }, wall: slow.wall, mono: slow.mono });
  assert.deepEqual(slowRequests, [1000, 600, 200]);
  assert.equal(slowResult.monoMs, 1000);
});

test('gap over 3x poll is host-freeze when wall time outruns monotonic time, else scheduler-stall; short gaps are not gaps', () => {
  const base = { pollMs: 1000 };
  assert.equal(classifyGap({ ...base, gapMs: 3000, wallDeltaMs: 3000, monoDeltaMs: 3000 }), null);
  assert.equal(classifyGap({ ...base, gapMs: 10_000, wallDeltaMs: 10_000, monoDeltaMs: 200 }), 'host-freeze');
  assert.equal(classifyGap({ ...base, gapMs: 10_000, wallDeltaMs: 10_000, monoDeltaMs: 9_500 }), 'scheduler-stall');
});

test('each classified gap is appended to the freeze ledger with start, end and class', () => {
  const store = memoryStore();
  const ledger = createFreezeLedger({ store });
  assert.equal(recordCycleGap({ ledger, pollMs: 1000, start: 100, end: 200, wallDeltaMs: 100, monoDeltaMs: 100 }), null);
  const entry = recordCycleGap({ ledger, pollMs: 1000, start: 1000, end: 1000 + 60_000, wallDeltaMs: 60_000, monoDeltaMs: 50 });
  assert.deepEqual(entry, { start: 1000, end: 61_000, class: 'host-freeze' });
  recordCycleGap({ ledger, pollMs: 1000, start: 70_000, end: 80_000, wallDeltaMs: 10_000, monoDeltaMs: 9_900 });
  assert.deepEqual(store.load(), [
    { start: 1000, end: 61_000, class: 'host-freeze' },
    { start: 70_000, end: 80_000, class: 'scheduler-stall' },
  ]);
  // A new ledger over the same store sees the persisted entries.
  assert.equal(createFreezeLedger({ store }).all().length, 2);
});

test('effective cap drops one step per freeze once the window holds the threshold, floors at the minimum, and recovers one step per freeze-free window', () => {
  const ledger = createFreezeLedger({ store: memoryStore() });
  const logs = [];
  const state = createCapState(4);
  const cap = (now) => effectiveCap({ base: 4, floor: 2, ledger, now, threshold: 3, windowMs: 6 * HOUR, state, log: (e) => logs.push(e) });
  const freeze = (start) => ledger.append({ start, end: start + 1000, class: 'host-freeze' });

  assert.equal(cap(0), 4);
  freeze(1 * HOUR); freeze(2 * HOUR);
  assert.equal(cap(3 * HOUR), 4, 'below threshold: no change');
  freeze(3 * HOUR);
  assert.equal(cap(3 * HOUR + 1000), 3, 'third freeze in window drops one');
  freeze(3.5 * HOUR);
  assert.equal(cap(3.5 * HOUR + 1000), 2, 'further freeze drops again');
  freeze(4 * HOUR);
  assert.equal(cap(4 * HOUR + 1000), 2, 'never below floor');

  // Freeze-free window after the last freeze (ends at 4h + 1s) recovers one step; not before.
  assert.equal(cap(4 * HOUR + 1000 + 6 * HOUR - 1), 2);
  assert.equal(cap(4 * HOUR + 1000 + 6 * HOUR), 3);
  assert.equal(cap(4 * HOUR + 1000 + 12 * HOUR), 4);
  assert.equal(cap(4 * HOUR + 1000 + 18 * HOUR), 4, 'never above base');

  assert.deepEqual(logs.map((e) => [e.from, e.to]), [[4, 3], [3, 2], [2, 3], [3, 4]]);
});

test('excluded intervals keep freeze and stall time out of the progress timer', () => {
  const ledger = createFreezeLedger({ store: memoryStore() });
  const MIN = 60_000;
  const events = [{ type: 'progress', at: 0 }];
  const now = 100 * MIN;
  assert.equal(detectStalls({ events, now }).length, 1, 'without exclusions, 100 min idle stalls');

  // A 30-minute host freeze inside the idle window is not charged as no-progress: 70 min remain.
  ledger.append({ start: 20 * MIN, end: 50 * MIN, class: 'host-freeze' });
  assert.deepEqual(detectStalls({ events, now, config: { excluded: excludedIntervals(ledger) } }), []);
  assert.deepEqual(detectStalls({ events, now: 130 * MIN, config: { excluded: excludedIntervals(ledger) } }).map((s) => s.signal), ['progress-stalled']);
});
