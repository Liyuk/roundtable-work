import test from 'node:test';
import assert from 'node:assert/strict';
import { initialState, observeCycle } from '../../runtime/lib/loop-stall.mjs';

// Fixtures only: every snapshot is built in memory; the clock is the injected `at`.
const HOUR = 3600000;
const DAY_AT = Date.UTC(2026, 10, 25, 12);
const issue = (number, fields = {}) => ({ number, state: 'OPEN', labels: [], deps: [], ...fields });
const snap = (fields) => ({ at: DAY_AT, awake: true, claimable: 0, activeWorkers: 0, issues: [], verifiedComplete: [], mainRed: false, freezes: [], ...fields });

// Feeds snapshots in order; returns the final state and every firing in order.
function run(snapshots, config) {
  let state = initialState();
  const firings = [];
  for (const snapshot of snapshots) {
    const result = observeCycle({ state, snapshot, config });
    state = result.state;
    firings.push(...result.firings);
  }
  return { state, firings };
}

test('#553 waiting on verified-complete #562 gives one verified-complete-leaf root with auto-close', () => {
  const snapshot = snap({
    issues: [issue(553, { labels: ['rt:go'], deps: [562] }), issue(562)],
    verifiedComplete: [562],
  });
  const { firings } = run(Array(6).fill(snapshot));
  assert.equal(firings.length, 1);
  assert.equal(firings[0].root, 562);
  assert.equal(firings[0].class, 'verified-complete-leaf');
  assert.equal(firings[0].action, 'auto-close');
});

test('a dependency cycle 10 -> 11 -> 10 gives a cycle root', () => {
  const snapshot = snap({
    issues: [issue(10, { labels: ['rt:go'], deps: [11] }), issue(11, { labels: ['rt:go'], deps: [10] })],
  });
  const { firings } = run(Array(6).fill(snapshot));
  assert.ok(firings.some((f) => f.class === 'cycle' && f.action === 'escalate'));
});

test('an unknown dependency and a mainRed verified-complete leaf are classified', () => {
  const unknown = snap({ issues: [issue(20, { labels: ['rt:go'], deps: [999] })] });
  assert.deepEqual(run(Array(6).fill(unknown)).firings.map((f) => [f.root, f.class]), [[999, 'unknown-dependency']]);
  const red = snap({ issues: [issue(30, { labels: ['rt:go'], deps: [31] }), issue(31)], verifiedComplete: [31], mainRed: true });
  assert.deepEqual(run(Array(6).fill(red)).firings.map((f) => [f.root, f.class]), [[31, 'main-red']]);
});

test('closed dependencies are satisfied and do not block the walk', () => {
  const snapshot = snap({ issues: [issue(40, { labels: ['rt:go'], deps: [41] }), issue(41, { state: 'CLOSED' })] });
  assert.deepEqual(run(Array(6).fill(snapshot)).firings.map((f) => [f.root, f.class]), [[40, 'unclaimed']]);
});

test('5 idle cycles fire nothing; the 6th fires one firing with one ledger line and one item', () => {
  const snapshot = snap({ issues: [issue(50, { labels: ['rt:go'] })] });
  const five = run(Array(5).fill(snapshot));
  assert.deepEqual(five.firings, []);
  const six = run(Array(6).fill(snapshot));
  assert.equal(six.firings.length, 1);
  const [firing] = six.firings;
  assert.equal(firing.kind, 'idle-backlog');
  assert.equal(firing.key, 'notice:stall:idle-backlog:50:2026-11-25');
  assert.equal(firing.ledger, '2026-11-25T12:00:00.000Z\tidle-backlog\t50\tunclaimed\tescalate\tnotice:stall:idle-backlog:50:2026-11-25\n');
  assert.deepEqual(firing.item, { id: firing.key, kind: 'notification', issue: 50, payload: { subtype: 'stall-alert', kind: 'idle-backlog', class: 'unclaimed', action: 'escalate' } });
});

test('a 7th cycle on the same day and a replayed state fire nothing', () => {
  const snapshot = snap({ issues: [issue(50, { labels: ['rt:go'] })] });
  const { state } = run(Array(6).fill(snapshot));
  assert.deepEqual(observeCycle({ state, snapshot, config: {} }).firings, []);
  const replay = observeCycle({ state, snapshot, config: {} });
  assert.deepEqual(replay.firings, []);
  assert.equal(replay.state.fired.length, 1);
});

test('a cycle with claimable work or live workers resets the idle count', () => {
  const idle = snap({ issues: [issue(50, { labels: ['rt:go'] })] });
  const busy = snap({ issues: [issue(50, { labels: ['rt:go'] })], activeWorkers: 1 });
  const { state } = run([idle, idle, idle, busy]);
  assert.equal(state.idleCycles, 0);
});

test('a blocked issue older than 4 h fires stale-wait with a stall-alert record', () => {
  const since = DAY_AT - 5 * HOUR;
  const snapshot = snap({ issues: [issue(60, { labels: ['rt:blocked'], since })] });
  const { firings } = observeCycle({ state: initialState(), snapshot, config: {} });
  assert.equal(firings.length, 1);
  assert.equal(firings[0].kind, 'stale-wait');
  assert.equal(firings[0].root, 60);
  assert.equal(firings[0].record.event, 'stall-alert');
  assert.equal(firings[0].record.issue, 60);
});

test('a 2 h freeze inside a 5 h wait leaves 3 h effective and does not fire', () => {
  const since = DAY_AT - 5 * HOUR;
  const freezes = [{ start: DAY_AT - 4 * HOUR, end: DAY_AT - 2 * HOUR }];
  const snapshot = snap({ issues: [issue(60, { labels: ['rt:blocked'], since })], freezes });
  assert.deepEqual(observeCycle({ state: initialState(), snapshot, config: {} }).firings, []);
});

test('an open ready-to-merge issue without an open PR is stale-wait; with a PR it is not', () => {
  const since = DAY_AT - 5 * HOUR;
  const noPr = snap({ issues: [issue(70, { labels: ['rt:ready-to-merge'], since, hasOpenPr: false })] });
  assert.equal(observeCycle({ state: initialState(), snapshot: noPr, config: {} }).firings.length, 1);
  const withPr = snap({ issues: [issue(70, { labels: ['rt:ready-to-merge'], since, hasOpenPr: true })] });
  assert.deepEqual(observeCycle({ state: initialState(), snapshot: withPr, config: {} }).firings, []);
});

test('a fired stale-wait key is not returned again on replay', () => {
  const snapshot = snap({ issues: [issue(60, { labels: ['rt:blocked'], since: DAY_AT - 5 * HOUR })] });
  const first = observeCycle({ state: initialState(), snapshot, config: {} });
  assert.equal(first.state.fired.length, 1);
  assert.deepEqual(observeCycle({ state: first.state, snapshot, config: {} }).firings, []);
});

test('a stale-wait episode that crosses UTC midnight fires once per 24 h of effective wait, not per date', () => {
  const since = Date.UTC(2026, 10, 25, 18);
  const blocked = (at) => snap({ at, issues: [issue(80, { labels: ['rt:blocked'], since })] });
  const atTwentyThree = blocked(Date.UTC(2026, 10, 25, 23));
  const nextMorning = blocked(Date.UTC(2026, 10, 26, 1, 30));
  const dayTwo = blocked(since + 24 * HOUR);
  const { firings } = run([atTwentyThree, nextMorning, dayTwo]);
  assert.deepEqual(firings.map((f) => f.key), [
    `notice:stall:stale-wait:80:${since}:0`,
    `notice:stall:stale-wait:80:${since}:1`,
  ]);
});
