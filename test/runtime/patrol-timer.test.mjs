import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';
import { PATROL_TIMER, ensurePatrolTimer, patrolCadenceMs, runPatrol } from '../../runtime/lib/patrol-timer.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const MIN = 60_000;
const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'patrol-timer-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const readJsonl = (root, rel) => readFileSync(join(root, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fakeActuator = () => {
  const calls = [];
  return { calls, act: async (call) => { calls.push(call); return { status: 'done' }; } };
};
// P4: main is red; `loopMerge` picks revert_candidate (owner-only) or pause_claims (allow-listed via pause-queue).
const red = (loopMerge) => ({ p4: { main: { state: 'red', sha: 'abc123', loopMerge } } });

test('the patrol timer fires every 30 min by default and not before', () => withRoot((root) => {
  const timers = openTimers(root);
  ensurePatrolTimer(timers, T0, patrolCadenceMs({}));
  assert.equal(timers.fire(T0), 1);
  assert.equal(timers.fire(T0 + 30 * MIN - 1), 0);
  assert.equal(timers.fire(T0 + 30 * MIN), 1);
  const events = openInbox(root).events();
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.kind === 'heartbeat' && e.issue === null && e.payload.job === 'patrol'));
}));

test('the patrol timer is registered once', () => withRoot((root) => {
  const timers = openTimers(root);
  ensurePatrolTimer(timers, T0, 5 * MIN);
  ensurePatrolTimer(timers, T0 + MIN, 5 * MIN);
  assert.deepEqual(timers.list().map((t) => [t.id, t.cadenceMs]), [[PATROL_TIMER, 5 * MIN]]);
}));

test('RT_PATROL_MS sets the cadence; it must be a positive integer of milliseconds', () => {
  assert.equal(patrolCadenceMs({ RT_PATROL_MS: '60000' }), 60_000);
  assert.throws(() => patrolCadenceMs({ RT_PATROL_MS: '0' }), TypeError);
  assert.throws(() => patrolCadenceMs({ RT_PATROL_MS: '1.5' }), TypeError);
  assert.throws(() => patrolCadenceMs({ RT_PATROL_MS: 'soon' }), TypeError);
});

test('STOP file present: the cycle is skipped, no detector, outbox or actuator write', () => withRoot(async (root) => {
  mkdirSync(join(root, '.roundtable/state'), { recursive: true });
  writeFileSync(join(root, '.roundtable/state/STOP'), '');
  const actuator = fakeActuator();
  const outbox = openOutbox(root);
  await runPatrol({ root, now: T0, inputs: red(true), outbox, actuator });
  assert.deepEqual(readJsonl(root, '.roundtable/state/patrol.jsonl'), [{ at: new Date(T0).toISOString(), kind: 'cycle', outcome: 'skipped-stop' }]);
  assert.deepEqual(actuator.calls, []);
  assert.deepEqual(outbox.items(), []);
}));

test('an action outside the allow-list is owner-only: recorded, enqueued, and never executed', () => withRoot(async (root) => {
  const actuator = fakeActuator();
  const outbox = openOutbox(root);
  await runPatrol({ root, now: T0, inputs: red(true), outbox, actuator });
  assert.deepEqual(actuator.calls, []);
  const [item] = outbox.items();
  assert.equal(item.kind, 'notification');
  assert.equal(item.issue, null);
  assert.deepEqual(item.payload, { subtype: 'patrol-owner-only', row: 'P4', action: 'revert_candidate' });
  const [iv] = openInterventions(root).entries().entries;
  assert.deepEqual([iv.source, iv.category, iv.ref], ['self', 'owner-only', 'rt:patrol']);
  assert.equal(iv.reason, 'patrol P4 finding revert_candidate: owner-only');
}));

test('an allow-listed action with an injected actuator goes through act, not the outbox', () => withRoot(async (root) => {
  const actuator = fakeActuator();
  const outbox = openOutbox(root);
  await runPatrol({ root, now: T0, inputs: red(false), outbox, actuator });
  assert.equal(actuator.calls.length, 1);
  assert.equal(actuator.calls[0].action, 'pause-queue');
  assert.equal(actuator.calls[0].findingSignature, 'P4:abc123');
  assert.deepEqual(outbox.items(), []);
  const [iv] = openInterventions(root).entries().entries;
  assert.deepEqual([iv.source, iv.category, iv.ref], ['self', 'liveness', 'rt:patrol']);
}));

test('an allow-listed action with no actuator injected becomes owner-only', () => withRoot(async (root) => {
  const outbox = openOutbox(root);
  await runPatrol({ root, now: T0, inputs: red(false), outbox });
  assert.equal(outbox.items()[0].payload.action, 'pause_claims');
  assert.equal(openInterventions(root).entries().entries[0].category, 'owner-only');
}));

test('each run writes one cycle entry and one entry per finding and per action to patrol.jsonl', () => withRoot(async (root) => {
  const actuator = fakeActuator();
  await runPatrol({ root, now: T0, inputs: red(false), outbox: openOutbox(root), actuator });
  const [cycle, finding, action] = readJsonl(root, '.roundtable/state/patrol.jsonl');
  assert.deepEqual(cycle, { at: new Date(T0).toISOString(), kind: 'cycle', outcome: 'ran', findings: 1 });
  assert.deepEqual(finding, { at: new Date(T0).toISOString(), kind: 'finding', row: 'P4', signature: 'P4:abc123', action: 'pause_claims', route: 'actuator' });
  assert.deepEqual(action, { at: new Date(T0).toISOString(), kind: 'action', row: 'P4', signature: 'P4:abc123', action: 'pause-queue', outcome: 'done' });
}));

test('observe-only findings are logged but write no intervention and no action', () => withRoot(async (root) => {
  const actuator = fakeActuator();
  const inputs = { p2: { items: [{ id: '7', state: 'working', since: T0 - 100 * MIN, staleHits: 0, requeued: false }] } };
  await runPatrol({ root, now: T0, inputs, outbox: openOutbox(root), actuator });
  const lines = readJsonl(root, '.roundtable/state/patrol.jsonl');
  assert.deepEqual(lines.map((l) => [l.kind, l.route ?? l.outcome]), [['cycle', 'ran'], ['finding', 'observe']]);
  assert.deepEqual(actuator.calls, []);
  assert.deepEqual(openInterventions(root).entries().entries, []);
}));

test('a persistent finding acted on in later cycles writes one self entry per cycle', () => withRoot(async (root) => {
  const actuator = fakeActuator();
  const outbox = openOutbox(root);
  await runPatrol({ root, now: T0, inputs: red(false), outbox, actuator });
  await runPatrol({ root, now: T0 + 30 * MIN, inputs: red(false), outbox, actuator });
  assert.equal(actuator.calls.length, 2);
  const selfEntries = openInterventions(root).entries().entries.filter((iv) => iv.source === 'self');
  assert.deepEqual(selfEntries.map((iv) => [iv.source, iv.category, iv.ref]), [['self', 'liveness', 'rt:patrol'], ['self', 'liveness', 'rt:patrol']]);
  assert.deepEqual(selfEntries.map((iv) => iv.at), [new Date(T0).toISOString(), new Date(T0 + 30 * MIN).toISOString()]);
}));
