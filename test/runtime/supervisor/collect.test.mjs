import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../../../runtime/supervisor/collect.mjs';

const HEARTBEAT = JSON.stringify({
  schemaVersion: 1,
  writtenAt: 1000,
  daemon: { pid: 4242, lastCycleAt: 900, state: 'running' },
  frontChief: { session: 'front-chief', lastTurnAt: 950, state: 'active' },
  lastMaterialProgress: { kind: 'verdict', at: 1000000, ref: 'review-7' },
});

function clients(calls) {
  const record = (name, value) => async (...args) => { calls.push([name, ...args]); return value; };
  return {
    listIssues: record('listIssues', [{ number: 249, state: 'open' }]),
    listPulls: record('listPulls', [{ number: 33, headSha: 'abc1234' }]),
    listChecks: record('listChecks', [{ name: 'test', status: 'completed', conclusion: 'success' }]),
    listComments: record('listComments', [{ id: 1, body: 'owner note' }]),
  };
}

function inputs(calls, overrides = {}) {
  return {
    now: 1000000 + 90000,
    readHeartbeat: async () => HEARTBEAT,
    readDaemonState: async () => 'running',
    readDaemonLog: async () => 'cycle ok\n',
    github: clients(calls),
    issue: 249,
    ...overrides,
  };
}

test('collects daemon state and log, the heartbeat and GitHub reads', async () => {
  const calls = [];
  const snapshot = await collect(inputs(calls));
  assert.equal(snapshot.daemon.state, 'running');
  assert.equal(snapshot.daemon.log, 'cycle ok\n');
  assert.equal(snapshot.heartbeat.ok, true);
  assert.equal(snapshot.heartbeat.value.frontChief.session, 'front-chief');
  assert.deepEqual(snapshot.github.issues, [{ number: 249, state: 'open' }]);
  assert.deepEqual(snapshot.github.pulls, [{ number: 33, headSha: 'abc1234' }]);
  assert.deepEqual(snapshot.github.checks, { 33: [{ name: 'test', status: 'completed', conclusion: 'success' }] });
  assert.deepEqual(snapshot.github.comments, [{ id: 1, body: 'owner note' }]);
});

test('time since last material progress comes from the injected clock', async () => {
  const snapshot = await collect(inputs([], { now: 1000000 + 90000 }));
  assert.equal(snapshot.sinceLastMaterialProgressMs, 90000);
});

test('a missing heartbeat is reported as missing, with no invented progress time', async () => {
  const snapshot = await collect(inputs([], { readHeartbeat: async () => undefined }));
  assert.deepEqual(snapshot.heartbeat, { ok: false, reason: 'missing' });
  assert.equal(snapshot.sinceLastMaterialProgressMs, null);
});

test('a malformed heartbeat is reported without throwing', async () => {
  const snapshot = await collect(inputs([], { readHeartbeat: async () => '{oops' }));
  assert.equal(snapshot.heartbeat.reason, 'malformed');
  assert.equal(snapshot.sinceLastMaterialProgressMs, null);
});

test('the collector only calls the injected read methods (no write calls)', async () => {
  const calls = [];
  await collect(inputs(calls));
  assert.deepEqual(calls.map(([name]) => name).sort(), ['listChecks', 'listComments', 'listIssues', 'listPulls']);
  assert.deepEqual(calls.find(([name]) => name === 'listComments'), ['listComments', 249]);
});
