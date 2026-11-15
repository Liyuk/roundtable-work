import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNAL_KINDS, detectSignals, detectPendingReview, detectStoppedMidway, detectAskTimeout, detectStalled,
  detectStartFailed, detectOrphaned, ownerActiveAt, createSignalLoop,
} from '../../../runtime/supervisor/signals.mjs';

const NOW = 10_000_000;
const MIN = 60_000;
const row = (overrides = {}) => ({
  id: 't1', status: 'running', owner: 'chief', checkpoint: null, askedAt: null, heartbeatAt: null, startError: null,
  ...overrides,
});
const sigs = (findings) => findings.map((f) => f.signature);

test('the signal kinds are a frozen list of the six kinds in order', () => {
  assert.equal(Object.isFrozen(SIGNAL_KINDS), true);
  assert.deepEqual([...SIGNAL_KINDS], ['pending-review', 'stopped-midway', 'ask-timeout', 'stalled', 'start-failed', 'orphaned']);
});

test('pending-review fires for pending-review rows and not for others', () => {
  const found = detectPendingReview([row({ id: 'a', status: 'pending-review' }), row({ id: 'b', status: 'running' })], NOW, {});
  assert.deepEqual(found, [{ kind: 'pending-review', signature: 'pending-review:a', taskId: 'a', evidence: { status: 'pending-review' } }]);
});

test('stopped-midway fires only for stopped rows that carry a checkpoint', () => {
  const tasks = [row({ id: 'a', status: 'stopped', checkpoint: { round: 2 } }), row({ id: 'b', status: 'stopped' })];
  assert.deepEqual(sigs(detectStoppedMidway(tasks, NOW, {})), ['stopped-midway:a']);
  assert.deepEqual(detectStoppedMidway(tasks, NOW, {})[0].evidence, { status: 'stopped' });
});

test('ask-timeout fires once an asking row has waited the default 2 hours', () => {
  const askedAt = NOW - 120 * MIN;
  const [f] = detectAskTimeout([row({ id: 'a', status: 'asking', askedAt })], NOW, {});
  assert.equal(f.signature, 'ask-timeout:a');
  assert.deepEqual(f.evidence, { ageMs: 120 * MIN });
});

test('ask-timeout stays silent inside the window and honours a configured askTimeoutMs', () => {
  const tasks = [row({ id: 'a', status: 'asking', askedAt: NOW - 119 * MIN })];
  assert.deepEqual(detectAskTimeout(tasks, NOW, {}), []);
  assert.equal(detectAskTimeout(tasks, NOW, { askTimeoutMs: 10 * MIN }).length, 1);
});

test('stalled fires for a running row whose heartbeat is 30 minutes old by default', () => {
  const [f] = detectStalled([row({ id: 'a', heartbeatAt: NOW - 30 * MIN })], NOW, {});
  assert.equal(f.signature, 'stalled:a');
  assert.deepEqual(f.evidence, { ageMs: 30 * MIN });
});

test('stalled stays silent for a fresh heartbeat and honours a configured stallMs', () => {
  const tasks = [row({ id: 'a', heartbeatAt: NOW - 29 * MIN })];
  assert.deepEqual(detectStalled(tasks, NOW, {}), []);
  assert.equal(detectStalled(tasks, NOW, { stallMs: 5 * MIN }).length, 1);
});

test('start-failed fires for any row with a startError and carries the message', () => {
  const tasks = [row({ id: 'a', startError: 'spawn ENOENT' }), row({ id: 'b' })];
  const found = detectStartFailed(tasks, NOW, {});
  assert.deepEqual(found, [{ kind: 'start-failed', signature: 'start-failed:a', taskId: 'a', evidence: { startError: 'spawn ENOENT' } }]);
});

test('orphaned fires for an active row with no owner, and not for an unowned inactive row', () => {
  const tasks = [row({ id: 'a', status: 'running', owner: null }), row({ id: 'b', status: 'done', owner: null })];
  const found = detectOrphaned(tasks, NOW, {});
  assert.deepEqual(sigs(found), ['orphaned:a']);
  assert.deepEqual(found[0].evidence, { status: 'running' });
});

test('detectSignals runs all six detectors and returns their findings', () => {
  const tasks = [
    row({ id: 'p', status: 'pending-review' }),
    row({ id: 's', status: 'stopped', checkpoint: {} }),
    row({ id: 'a', status: 'asking', askedAt: NOW - 3 * 60 * MIN }),
    row({ id: 'r', status: 'running', heartbeatAt: NOW - 60 * MIN }),
    row({ id: 'f', status: 'queued', startError: 'boom' }),
    row({ id: 'o', status: 'running', owner: null }),
  ];
  assert.deepEqual(sigs(detectSignals(tasks, NOW)), [
    'pending-review:p', 'stopped-midway:s', 'ask-timeout:a', 'stalled:r', 'start-failed:f', 'orphaned:o',
  ]);
});

test('ownerActiveAt returns the latest comment by the owner and ignores others', () => {
  const comments = [{ author: 'chief', at: 100 }, { author: 'bot', at: 500 }, { author: 'chief', at: 300 }];
  assert.equal(ownerActiveAt(comments, 'chief'), 300);
  assert.equal(ownerActiveAt(comments, 'nobody'), null);
  assert.equal(ownerActiveAt([], 'chief'), null);
});

const finding = (id, kind = 'stalled') => ({ kind, signature: `${kind}:${id}`, taskId: id, evidence: {} });
const quiet = { ownerActiveAt: null };

test('the same finding in two cycles delivers one message, then nothing', () => {
  const loop = createSignalLoop({});
  const first = loop.cycle({ findings: [finding('a')], now: NOW, ...quiet });
  assert.equal(first.message.text, 'stalled a');
  const second = loop.cycle({ findings: [finding('a')], now: NOW + MIN, ...quiet });
  assert.equal(second.message, null);
  assert.equal(second.held, 0);
});

test('a cleared condition that reappears is delivered again', () => {
  const loop = createSignalLoop({ windowMs: 0 });
  loop.cycle({ findings: [finding('a')], now: NOW, ...quiet });
  loop.cycle({ findings: [], now: NOW + MIN, ...quiet });
  const again = loop.cycle({ findings: [finding('a')], now: NOW + 2 * MIN, ...quiet });
  assert.equal(again.message.signatures[0], 'stalled:a');
});

test('two findings in one cycle merge into one message with two lines', () => {
  const loop = createSignalLoop({});
  const { message } = loop.cycle({ findings: [finding('b'), finding('a', 'orphaned')], now: NOW, ...quiet });
  assert.deepEqual(message.signatures, ['orphaned:a', 'stalled:b']);
  assert.equal(message.text, 'orphaned a\nstalled b');
  assert.equal(message.at, NOW);
});

test('duplicate signatures within one cycle collapse to one line', () => {
  const loop = createSignalLoop({});
  const { message } = loop.cycle({ findings: [finding('a'), finding('a')], now: NOW, ...quiet });
  assert.equal(message.text, 'stalled a');
});

test('the same signature set inside windowMs is rate-limited; after windowMs it is delivered', () => {
  const loop = createSignalLoop({ windowMs: 30 * MIN, holdMs: 0 });
  loop.cycle({ findings: [finding('a')], now: NOW, ...quiet });
  loop.cycle({ findings: [], now: NOW + MIN, ...quiet });
  const inside = loop.cycle({ findings: [finding('a')], now: NOW + 29 * MIN, ...quiet });
  assert.equal(inside.message, null);
  assert.equal(inside.held, 1);
  const after = loop.cycle({ findings: [finding('a')], now: NOW + 30 * MIN, ...quiet });
  assert.deepEqual(after.message.signatures, ['stalled:a']);
});

test('an owner active within holdMs holds the message; it is delivered once the hold ends', () => {
  const loop = createSignalLoop({ holdMs: 10 * MIN });
  const held = loop.cycle({ findings: [finding('a')], now: NOW, ownerActiveAt: NOW - MIN });
  assert.equal(held.message, null);
  assert.equal(held.held, 1);
  const stillHeld = loop.cycle({ findings: [finding('a')], now: NOW + 8 * MIN, ownerActiveAt: NOW - MIN });
  assert.equal(stillHeld.message, null);
  const delivered = loop.cycle({ findings: [finding('a')], now: NOW + 10 * MIN, ownerActiveAt: NOW - MIN });
  assert.deepEqual(delivered.message.signatures, ['stalled:a']);
  assert.equal(delivered.held, 0);
});
