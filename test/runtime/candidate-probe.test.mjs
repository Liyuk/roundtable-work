import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCandidateRouter } from '../../runtime/lib/fallback.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { openContinuation, executorOf, startRound, closeRound, gate1Pass, runRound } from '../../runtime/lib/executor-record.mjs';

const T0 = Date.parse('2026-01-01T00:00:00Z');
const candidates = { developer: [{ harness: 'pi', model: 'dev-pi' }, { harness: 'host-agent', model: 'dev-host' }] };
const TTL = 60_000;
const limited = (retryAfter) => Object.assign(new Error('too many requests'), { status: 429, retryAfter });
const quota = () => ({ exitCode: 1, reason: 'budget_exhausted', output: '' });

// Throwaway state directories keep the real timers store off the host; no host paths appear in this file.
const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'probe-test-'));
  const anchor = mkdtempSync(join(tmpdir(), 'probe-anchor-'));
  process.env.RTW_STATE_DIR = anchor;
  try { await fn(root); } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(anchor, { recursive: true, force: true });
  }
};

// `dev(candidate, phase)` answers each call ('probe' or 'work') with an outcome or a thrown error.
function rig(root, dev = () => 'ok') {
  const clock = { t: T0 };
  const router = createCandidateRouter({ candidates, ttlMs: TTL, now: () => clock.t });
  const timers = openTimers(root);
  const calls = { probe: [], work: [] };
  const invoke = (phase) => (candidate) => { calls[phase].push(candidate.model); return dev(candidate, phase); };
  const round = (cont, kind) => runRound({
    router, role: 'developer', cont, kind, timers, timerId: 'wait:309:developer',
    event: { kind: 'heartbeat', issue: 309, payload: { wait: 'quota' } },
    probe: invoke('probe'), worker: invoke('work'),
  });
  return { clock, timers, calls, round, at: (ms) => { clock.t = T0 + ms; } };
}

test('a preferred candidate 429 moves to the alternate at once, with no wait', async () => {
  await withRoot(async (root) => {
    const r = rig(root, (c) => { if (c.model === 'dev-pi') throw limited(60); return `ok:${c.model}`; });
    assert.equal(await r.round(openContinuation(), 'implement'), 'ok:dev-host');
    assert.deepEqual(r.calls.work, ['dev-pi', 'dev-host']);
  });
});

test('all candidates unavailable: the round returns a wait record with the unblock time and writes a due timer; no worker runs', async () => {
  await withRoot(async (root) => {
    const r = rig(root, (c) => { throw limited(c.model === 'dev-pi' ? 5 : 10); });
    const wait = await r.round(openContinuation(), 'implement');
    assert.deepEqual([wait.class, wait.decision, wait.status, wait.unblockAt], ['quota_wait', 'wait', 'waiting_external', T0 + 5000]);
    assert.equal(r.timers.list()[0].at, T0 + 5000);
    assert.equal(r.timers.list()[0].id, 'wait:309:developer');
  });
});

test('no worker dispatch between the limit and the unblock time; probes are not worker dispatches', async () => {
  await withRoot(async (root) => {
    const r = rig(root, (c) => { throw limited(c.model === 'dev-pi' ? 5 : 600); });
    const cont = openContinuation();
    await r.round(cont, 'implement');
    for (const ms of [0, 1000, 4999]) {
      r.at(ms);
      assert.equal((await r.round(cont, 'implement')).decision, 'wait', `at ${ms}`);
    }
    assert.deepEqual(r.calls.work, ['dev-pi', 'dev-host'], 'only the first round dispatched workers');
    assert.deepEqual(r.calls.probe, [], 'probes run only at unblock time');
  });
});

test('at the unblock time the due timer fires, a probe runs, and a recovered preferred candidate is used again (switch back)', async () => {
  await withRoot(async (root) => {
    let up = false;
    const r = rig(root, (c, phase) => {
      if (c.model === 'dev-pi' && !up) throw limited(5);
      if (c.model === 'dev-host') throw limited(600);
      return `ok:${c.model}`;
    });
    const cont = openContinuation();
    await r.round(cont, 'implement');
    r.at(5000);
    up = true;
    assert.equal(r.timers.fire(T0 + 5000), 1);
    assert.equal(await r.round(cont, 'implement'), 'ok:dev-pi');
    assert.deepEqual(r.calls.probe, ['dev-pi'], 'the probe ran on the preferred candidate');
  });
});

test('a failed probe at unblock time keeps waiting and never runs a worker', async () => {
  await withRoot(async (root) => {
    const r = rig(root, (c) => { throw limited(c.model === 'dev-pi' ? 5 : 600); });
    const cont = openContinuation();
    await r.round(cont, 'implement');
    r.at(5000);
    const again = await r.round(cont, 'implement');
    assert.equal(again.decision, 'wait');
    assert.equal(again.unblockAt, T0 + 10000, 'the failed probe re-arms the preferred candidate from its new Retry-After');
    assert.deepEqual(r.calls.probe, ['dev-pi']);
    assert.deepEqual(r.calls.work, ['dev-pi', 'dev-host'], 'no worker dispatched by the failed probe');
  });
});

test('probing never consumes developer attempts: counters and rounds are unchanged', async () => {
  await withRoot(async (root) => {
    const r = rig(root, (c) => { throw limited(c.model === 'dev-pi' ? 5 : 600); });
    const cont = openContinuation();
    await r.round(cont, 'implement');
    const before = structuredClone(cont);
    for (const ms of [5000, 5000, 9000]) { r.at(ms); await r.round(cont, 'implement'); }
    assert.deepEqual(cont.counters, before.counters);
    assert.equal(cont.rounds.length, before.rounds.length);
  });
});

test('continuation records list the executor (role, harness, model) for every round and a degraded flag', async () => {
  await withRoot(async (root) => {
    const r = rig(root, (c) => { if (c.model === 'dev-pi') throw limited(600); return `ok:${c.model}`; });
    const cont = openContinuation();
    await r.round(cont, 'implement');
    assert.deepEqual(cont.rounds[0].executors.at(-1), { role: 'developer', harness: 'host-agent', model: 'dev-host', degraded: true, independent: false });
    assert.equal(cont.degraded, true);
  });
});

test('a worker round on the preferred candidate is not degraded', async () => {
  await withRoot(async (root) => {
    const r = rig(root);
    const cont = openContinuation();
    await r.round(cont, 'implement');
    assert.deepEqual(cont.rounds[0].executors, [{ role: 'developer', harness: 'pi', model: 'dev-pi', degraded: false, independent: true }]);
    assert.equal(cont.degraded, false);
  });
});

test('a Chief-implemented round is marked not independent and never passes Gate 1', () => {
  const cont = openContinuation();
  const chief = executorOf({ harness: 'pi', model: 'chief-model' }, { role: 'chief', independent: false });
  startRound(cont, 'implement', chief);
  closeRound(cont, 'returned');
  assert.equal(cont.rounds[0].executors[0].independent, false);
  assert.equal(gate1Pass(chief, 'passed'), false);
  assert.equal(gate1Pass(executorOf({ harness: 'pi', model: 'dev-pi' }, { role: 'developer' }), 'passed'), true);
});

test('a quota limit mid-session switches candidate inside the same round: counters unchanged, interruption and resumed executor recorded', async () => {
  await withRoot(async (root) => {
    const r = rig(root, (c) => (c.model === 'dev-pi' ? quota() : `ok:${c.model}`));
    const cont = openContinuation();
    assert.equal(await r.round(cont, 'implement'), 'ok:dev-host');
    assert.deepEqual(cont.counters, { implement: 1, fix: 0 });
    assert.equal(cont.rounds.length, 1);
    assert.deepEqual(cont.rounds[0].interruptions, [{ reason: 'quota', executor: executorOf({ harness: 'pi', model: 'dev-pi' }, { role: 'developer' }) }]);
    assert.deepEqual(cont.rounds[0].executors.map((e) => e.model), ['dev-pi', 'dev-host']);
    assert.equal(cont.rounds[0].status, 'returned');
  });
});

test('a round interrupted with every candidate down resumes as the same round after the unblock, with the resuming executor recorded', async () => {
  await withRoot(async (root) => {
    let up = false;
    const r = rig(root, (c) => { if (!up || c.model === 'dev-host') throw limited(c.model === 'dev-pi' ? 5 : 600); return `ok:${c.model}`; });
    const cont = openContinuation();
    assert.equal((await r.round(cont, 'fix')).decision, 'wait');
    assert.equal(cont.rounds[0].status, 'interrupted');
    up = true;
    r.at(5000);
    assert.equal(r.timers.fire(T0 + 5000), 1);
    assert.equal(await r.round(cont, 'fix'), 'ok:dev-pi');
    assert.deepEqual(cont.counters, { implement: 0, fix: 1 });
    assert.equal(cont.rounds.length, 1);
    assert.deepEqual(cont.rounds[0].executors.map((e) => e.model), ['dev-pi', 'dev-host', 'dev-pi']);
    assert.equal(cont.rounds[0].interruptions.length, 2);
    assert.equal(cont.rounds[0].status, 'returned');
  });
});

test('every candidate limited with Retry-After 0: the round waits with a finite probe time and a due timer, and does not throw', async () => {
  await withRoot(async (root) => {
    const r = rig(root, () => { throw limited(0); });
    const wait = await r.round(openContinuation(), 'implement');
    assert.deepEqual([wait.class, wait.decision, wait.status], ['quota_wait', 'wait', 'waiting_external']);
    assert.ok(Number.isFinite(wait.unblockAt) && Number.isFinite(wait.probeAt));
    assert.ok(wait.probeAt > T0, 'the timer is strictly in the future');
    assert.equal(r.timers.list()[0].at, wait.probeAt);
    assert.deepEqual(r.calls.work, ['dev-pi', 'dev-host'], 'only the single attempt set of the round');
  });
});
