import test from 'node:test';
import assert from 'node:assert/strict';
import { readSchedLog } from '../scripts/rt-bench/sched-log.mjs';
import { computeU } from '../scripts/rt-bench/metrics-u.mjs';

// Fixture lines in the host/rt-sched.py formats (docs/autonomy-benchmark.md section 3-4).
// Expected instants are worked out by hand: CST is UTC+8, PST is UTC-8.
const LOG = [
  '2026-11-16 10:00:00 CST rt-sched start pid=101 dry=False once=False workers=2 poll=30s',
  '2026-11-16 10:01:00 CST spawned worker #7 slot=0',
  '2026-11-16 10:05:00 CST worker #7 exited rc=124 state=running',
  '2026-11-16 10:06:00 PST WARN scheduler cycle gap 900s (poll=30s)',
  '2026-11-16 10:07:00 CST worker #8 exited rc=-15',
  '2026-11-16 10:08:00 CST rt-sched start pid=102 dry=True once=False workers=2 poll=30s',
  '2026-11-16 10:09:00 CST rt-sched start pid=103 dry=False once=False workers=2 poll=30s',
  '2026-11-16 10:10:00 XYZ bad zone',
  '2026-11-16 10:11:00 CST dispatch issue #5',
].join('\n');

test('stage exits with rc=124 and rc=-15 become stage events with at, rc and finalState', () => {
  const { events } = readSchedLog(LOG);
  const stages = events.filter((e) => e.kind === 'stage');
  assert.deepEqual(
    stages.map(({ at, rc, finalState, worker }) => ({ at, rc, finalState, worker })),
    [
      { at: '2026-11-16T02:05:00.000Z', rc: 124, finalState: 'running', worker: 7 },
      { at: '2026-11-16T02:07:00.000Z', rc: -15, finalState: null, worker: 8 },
    ],
  );
});

test('the stage events are accepted by computeU (U5 counts both)', () => {
  const now = Date.parse('2026-11-16T20:00:00Z');
  const stages = readSchedLog(LOG).events.filter((e) => e.kind === 'stage');
  const u5 = computeU({ now, productionStart: now - 30 * 24 * 3600e3, sources: { stages: { asOf: now - 60e3, events: stages } } }).find((r) => r.id === 'U5');
  assert.deepEqual([u5.value, u5.measurable], [2, true]);
});

test('live starts only, the first is not manual and later ones are manual', () => {
  const starts = readSchedLog(LOG).events.filter((e) => e.kind === 'start');
  assert.deepEqual(starts.map((s) => [s.pid, s.by]), [[101, 'first'], [103, 'manual']]);
});

test('cycle gap: at is the line time minus N s, resumedAt is the line time', () => {
  const gap = readSchedLog(LOG).events.find((e) => e.kind === 'gap');
  assert.deepEqual([gap.at, gap.resumedAt, gap.seconds], ['2026-11-16T17:51:00.000Z', '2026-11-16T18:06:00.000Z', 900]);
});

test('spawn lines are kept, and a line with a bad zone is malformed, never guessed', () => {
  const parsed = readSchedLog(LOG);
  assert.deepEqual(parsed.events.filter((e) => e.kind === 'spawn').map((e) => [e.worker, e.slot]), [[7, 0]]);
  assert.equal(parsed.malformed, 1);
  assert.equal(parsed.lastSeen, '2026-11-16T17:51:00.000Z');
});
