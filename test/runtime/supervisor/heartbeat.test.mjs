import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartbeat, writeHeartbeat, HEARTBEAT_PATH } from '../../../runtime/supervisor/heartbeat.mjs';

const VALID = {
  schemaVersion: 1,
  writtenAt: 1000,
  daemon: { pid: 4242, lastCycleAt: 900, state: 'running' },
  frontChief: { session: 'front-chief', lastTurnAt: 950, state: 'active' },
  lastMaterialProgress: { kind: 'commit', at: 800, ref: 'abc1234' },
};
const text = (value) => JSON.stringify(value);

test('heartbeat path is the documented workspace-relative file', () => {
  assert.equal(HEARTBEAT_PATH, '.roundtable/state/heartbeat.json');
});

test('a valid heartbeat parses to its value', () => {
  assert.deepEqual(parseHeartbeat(text(VALID)), { ok: true, value: VALID });
});

test('a missing heartbeat (no file content) is reported as missing', () => {
  assert.deepEqual(parseHeartbeat(undefined), { ok: false, reason: 'missing' });
});

test('malformed JSON is reported as malformed without throwing', () => {
  const result = parseHeartbeat('{"schemaVersion": 1,');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed');
});

test('an unknown progress kind is rejected as invalid-schema', () => {
  const result = parseHeartbeat(text({ ...VALID, lastMaterialProgress: { kind: 'deploy', at: 800, ref: 'x' } }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-schema');
});

test('an unknown state value is rejected as invalid-schema', () => {
  const result = parseHeartbeat(text({ ...VALID, frontChief: { ...VALID.frontChief, state: 'asleep' } }));
  assert.equal(result.reason, 'invalid-schema');
});

test('a wrong schemaVersion is rejected as invalid-schema', () => {
  assert.equal(parseHeartbeat(text({ ...VALID, schemaVersion: 2 })).reason, 'invalid-schema');
});

test('lastMaterialProgress may be null when no progress has been recorded yet', () => {
  assert.deepEqual(parseHeartbeat(text({ ...VALID, lastMaterialProgress: null })), { ok: true, value: { ...VALID, lastMaterialProgress: null } });
});

test('the writer encodes a heartbeat that the parser reads back unchanged', () => {
  const written = [];
  writeHeartbeat(VALID, { write: (file, content) => written.push({ file, content }) });
  assert.equal(written[0].file, HEARTBEAT_PATH);
  assert.deepEqual(parseHeartbeat(written[0].content), { ok: true, value: VALID });
});

test('the writer refuses to write an invalid heartbeat', () => {
  const written = [];
  assert.throws(() => writeHeartbeat({ ...VALID, daemon: { pid: 'x' } }, { write: (f, c) => written.push(c) }), /invalid heartbeat/);
  assert.deepEqual(written, []);
});
