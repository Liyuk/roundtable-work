import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, MODES } from '../../../runtime/supervisor/modes.mjs';
import { createLedger } from '../../../runtime/supervisor/ledger.mjs';

const counter = () => { let n = 0; return () => `id-${++n}`; };
const stale = { rule: 'pause-provenance-stale', signature: 'pause-provenance-stale:abc', at: 1000, evidence: { ref: 'abc', ageMs: 99999 } };
const heartbeat = { rule: 'heartbeat-stale', signature: 'heartbeat-stale:daemon', at: 1000, evidence: { target: 'daemon', ageMs: 600000 } };

const setup = () => {
  const entries = [];
  const ledger = createLedger({ append: (line) => entries.push(JSON.parse(line)), newId: counter(), now: () => 1000 });
  const calls = [];
  const actuator = { requeue: (ref) => calls.push(ref) };
  return { ledger, calls, actuator, entries };
};

test('the modes constant is frozen and lists observe and apply', () => {
  assert.equal(Object.isFrozen(MODES), true);
  assert.deepEqual(MODES, ['observe', 'apply']);
});

test('observe + stale pause records a void-stale-pause decision and never calls the actuator', () => {
  const { ledger, calls, actuator, entries } = setup();
  const written = dispatch({ mode: 'observe', finding: stale, ledger, actuator });
  assert.equal(calls.length, 0);
  assert.equal(written.length, 1);
  assert.equal(entries[0].action, 'void-stale-pause');
  assert.equal(entries[0].mode, 'observe');
  assert.equal(entries[0].findingSignature, stale.signature);
  assert.match(entries[0].reason, /abc/);
  assert.match(entries[0].reason, /99999/);
  assert.match(entries[0].reason, /would void/);
});

test('observe + any other finding records an observe-only entry and never calls the actuator', () => {
  const { ledger, calls, actuator, entries } = setup();
  dispatch({ mode: 'observe', finding: heartbeat, ledger, actuator });
  assert.equal(calls.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'observe-only');
  assert.equal(entries[0].reason, 'heartbeat-stale');
});

test('apply + stale pause requeues the ref once and writes a requeue child on the same trace', () => {
  const { ledger, calls, actuator, entries } = setup();
  const written = dispatch({ mode: 'apply', finding: stale, ledger, actuator, parentId: 'root' });
  assert.deepEqual(calls, ['abc']);
  assert.equal(written.length, 2);
  const [decision, child] = entries;
  assert.equal(decision.action, 'void-stale-pause');
  assert.equal(decision.mode, 'apply');
  assert.equal(decision.parentId, 'root');
  assert.equal(child.action, 'requeue');
  assert.equal(child.mode, 'apply');
  assert.equal(child.parentId, decision.id);
  assert.equal(child.traceId, decision.traceId);
});

test('apply + non-pause rule records observe-only and does not requeue', () => {
  const { ledger, calls, actuator, entries } = setup();
  dispatch({ mode: 'apply', finding: heartbeat, ledger, actuator });
  assert.equal(calls.length, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'observe-only');
});

test('unknown mode throws', () => {
  const { ledger, actuator } = setup();
  assert.throws(() => dispatch({ mode: 'yolo', finding: stale, ledger, actuator }), TypeError);
});

test('apply without an actuator requeue throws', () => {
  const { ledger } = setup();
  assert.throws(() => dispatch({ mode: 'apply', finding: stale, ledger }), TypeError);
  assert.throws(() => dispatch({ mode: 'apply', finding: stale, ledger, actuator: {} }), TypeError);
});
