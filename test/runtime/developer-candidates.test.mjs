import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { runQueue } from './observation-fixture.mjs';

// Developer candidates in the rtd pass (#309), driven by a fake clock; no real sleep.
const ANCHOR = mkdtempSync(join(tmpdir(), 'rt-dev-cand-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const T0 = Date.parse('2026-01-01T00:00:00Z');
const candidates = { developer: [{ harness: 'pi', model: 'dev-pi' }, { harness: 'host-agent', model: 'dev-host' }] };
const limited = (retryAfter) => Object.assign(new Error('too many requests'), { status: 429, retryAfter });
const OK = { exitCode: 0, output: 'ok' };

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), 'rt-dev-cand-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

// `dev(candidate)` answers each developing dispatch; the other phases always pass.
function rig(root, dev, extra = {}) {
  const clock = { t: T0 };
  const calls = [];
  const handler = async ({ phase, candidate }) => {
    if (phase !== 'developing') return OK;
    calls.push(candidate.model);
    return dev(candidate);
  };
  const pass = (options = {}) => runQueue({ workRoot: root, queue: ['309'], handler, candidates, now: () => clock.t, ...extra, ...options });
  return { clock, calls, pass, at: (ms) => { clock.t = T0 + ms; } };
}

test('a worker round records the executor and is not degraded on the preferred candidate', () => withRoot(async (root) => {
  const r = rig(root, () => OK);
  await r.pass();
  const cont = (await (await createStateStore({ workRoot: root })).load('309')).continuation;
  assert.deepEqual(cont.rounds[0].executors, [{ role: 'developer', harness: 'pi', model: 'dev-pi', degraded: false, independent: true }]);
  assert.deepEqual(cont.counters, { implement: 1, fix: 0 });
  assert.equal(cont.degraded, false);
}));

test('a 429 on the preferred candidate runs the round on the alternate, which is recorded as degraded and not independent', () => withRoot(async (root) => {
  const r = rig(root, (c) => (c.model === 'dev-pi' ? Promise.reject(limited(600)) : OK));
  const result = await r.pass();
  assert.notEqual(result.outcomes[0].class, 'quota_wait', 'the round moves on to the alternate');
  assert.deepEqual(r.calls.slice(0, 2), ['dev-pi', 'dev-host']);
  const cont = (await (await createStateStore({ workRoot: root })).load('309')).continuation;
  assert.equal(cont.degraded, true);
  assert.deepEqual(cont.rounds[0].executors.map((e) => [e.model, e.degraded, e.independent]), [['dev-pi', false, true], ['dev-host', true, false]]);
  assert.equal(cont.rounds[0].status, 'returned');
}));

test('a Chief-implemented round is recorded as not independent', () => withRoot(async (root) => {
  const r = rig(root, () => ({ ...OK, author: 'chief' }), { chiefImplements: true });
  await r.pass();
  const cont = (await (await createStateStore({ workRoot: root })).load('309')).continuation;
  assert.equal(cont.rounds[0].executors[0].independent, false);
}));

test('all candidates unavailable: the pass waits with a due timer and dispatches no worker before the unblock time', () => withRoot(async (root) => {
  const r = rig(root, (c) => { throw limited(c.model === 'dev-pi' ? 5 : 600); });
  const first = await r.pass();
  assert.deepEqual([first.outcomes[0].status, first.outcomes[0].class, first.outcomes[0].decision], ['waiting_external', 'quota_wait', 'wait']);
  const timer = openTimers(root).list().find((t) => t.id === 'wait:309:developer');
  assert.equal(timer.at, T0 + 5000);
  assert.equal(r.calls.length, 2);
  r.at(1000);
  assert.equal((await r.pass()).outcomes[0].decision, 'wait');
  assert.equal(r.calls.length, 2, 'no worker before the unblock time');
  const state = await (await createStateStore({ workRoot: root })).load('309');
  assert.equal(state.attempts.developer, 0);
}));

test('interval probe: a due probe switches back to the recovered preferred candidate before its Retry-After', () => withRoot(async (root) => {
  let up = false;
  const probes = [];
  const r = rig(root, (c) => { if (c.model === 'dev-pi' && !up) throw limited(600); if (c.model === 'dev-host') throw limited(600); return OK; }, {
    probeIntervalMs: 1000,
    probe: async ({ candidate }) => {
      probes.push(candidate.model);
      if (candidate.model === 'dev-pi' && !up) throw limited(600);
      if (candidate.model === 'dev-host') throw limited(600);
      return { exitCode: 0, output: 'probe ok' };
    },
  });
  await r.pass();
  assert.equal(openTimers(root).list().find((t) => t.id === 'wait:309:developer').at, T0 + 1000, 'the timer is the probe interval, not the unblock time');
  up = true;
  r.at(1000);
  assert.equal(openTimers(root).fire(T0 + 1000), 1);
  const result = await r.pass();
  assert.notEqual(result.outcomes[0].class, 'quota_wait');
  assert.deepEqual(probes, ['dev-pi', 'dev-host'], 'the probe ran and no full worker was used for it');
  assert.deepEqual(r.calls, ['dev-pi', 'dev-host', 'dev-pi'], 'the recovered preferred candidate serves the round');
  assert.equal((await (await createStateStore({ workRoot: root })).load('309')).attempts.developer, 0);
}));

test('a round interrupted by quota resumes as the same round after the unblock, with counters unchanged', () => withRoot(async (root) => {
  let up = false;
  const r = rig(root, (c) => { if (!up || c.model === 'dev-host') throw limited(c.model === 'dev-pi' ? 5 : 10); return OK; });
  assert.equal((await r.pass()).outcomes[0].decision, 'wait');
  let cont = (await (await createStateStore({ workRoot: root })).load('309')).continuation;
  assert.equal(cont.rounds[0].status, 'interrupted');
  up = true;
  r.at(10_000);
  assert.equal(openTimers(root).fire(T0 + 10_000), 1);
  await r.pass();
  cont = (await (await createStateStore({ workRoot: root })).load('309')).continuation;
  assert.deepEqual(cont.counters, { implement: 1, fix: 0 });
  assert.equal(cont.rounds.length, 1);
  assert.deepEqual(cont.rounds[0].executors.map((e) => e.model), ['dev-pi', 'dev-host', 'dev-pi']);
  assert.equal(cont.rounds[0].interruptions.length, 2);
  assert.equal(cont.rounds[0].status, 'returned');
}));
