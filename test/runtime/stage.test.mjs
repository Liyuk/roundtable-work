import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stage, observerAllows, heartbeatVerdict } from '../../runtime/lib/stage.mjs';
import { DEFAULT_POLL_MS } from '../../runtime/lib/daemon-loop.mjs';
import { parseHeartbeat } from '../../runtime/supervisor/heartbeat.mjs';
import { ALLOWED_ACTIONS } from '../../runtime/supervisor/actuator.mjs';
import observer from '../../runtime/defaults/observer.json' with { type: 'json' };

// Seams: stage(input) and observerAllows(action) (pure), and scripts/rt-stage.mjs on temp workspaces.
// Fixture clock: NOW = 2026-11-15T00:00Z. Goals carry only the fields the checker reads (shipped values).
const NOW = Date.UTC(2026, 10, 15);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();
const GOALS = { metrics: { windowDays: 7 }, exit: { windowHours: 72, minMergedPrs: 6, minSelfSourcedCompleted: 1 } };
const CLI = resolve(import.meta.dirname, '../../scripts/rt-stage.mjs');

const selfEntry = (ms, category = 'self-repair', internalized = 'yes') => ({ at: iso(ms), category, ref: '#4', reason: 'fixture', internalized, source: 'self' });
const ownerEntry = (ms, category) => ({ at: iso(ms), category, ref: '#3', reason: 'fixture', internalized: 'yes', source: 'owner' });
// One self entry in each of the last 7 days: covers every day of the ledger window.
const daily = () => Array.from({ length: 7 }, (_, d) => selfEntry(NOW - d * DAY - HOUR));
const hostFreeze = { start: NOW - 4 * DAY - HOUR, end: NOW - 3 * DAY, class: 'host-freeze' };
const closed = (n, stateReason = 'completed') => Array.from({ length: n }, (_, i) => ({ at: iso(NOW - (i + 1) * DAY), stateReason }));
const merges = (n) => Array.from({ length: n }, (_, i) => ({ at: iso(NOW - (i + 1) * HOUR), kind: 'merge' }));
const run = (input) => ({ freezes: [], heartbeatVerdict: 'fresh', merged: [], selfSourcedClosed: [], goals: GOALS, now: NOW, ...input });

test('S0: an empty ledger gives stage 0 with n/a streak and MTBI', () => {
  const s = stage(run({ entries: [] }));
  assert.equal(s.stage, 0);
  assert.deepEqual(s.streakHours, { na: 'intervention ledger is empty' });
  assert.deepEqual(s.mtbi, { value: 168, bound: 'lower' });
  assert.deepEqual(Object.values(s.capabilities), Array(8).fill('self'));
});

test('S1: a ledger with gaps in the last 7 days is stage 1', () => {
  assert.equal(stage(run({ entries: [selfEntry(NOW - 2 * HOUR)] })).stage, 1);
});

test('S2: daily coverage with a counted liveness entry in the last 7 days is stage 2', () => {
  const s = stage(run({ entries: [...daily(), ownerEntry(NOW - 2 * DAY, 'liveness')] }));
  assert.equal(s.stage, 2);
  assert.ok(s.unmet.includes('counted liveness or resource entry in the last 7 days'));
});

test('S3: a host-freeze recovered by a fresh heartbeat, with a counted decision in 14 days, is stage 3', () => {
  const s = stage(run({ entries: [...daily(), ownerEntry(NOW - 10 * DAY, 'decision')], freezes: [hostFreeze] }));
  assert.equal(s.stage, 3);
  assert.deepEqual(s.unmet, ['counted decision entry in the last 14 days']);
});

test('S4: no decisions, backlog or self-review in 14 days, but fewer than 3 closures, is stage 4', () => {
  const s = stage(run({ entries: daily(), freezes: [hostFreeze], selfSourcedClosed: closed(2) }));
  assert.equal(s.stage, 4);
  assert.deepEqual(s.unmet, ['fewer than 3 self-sourced issues closed by merged PR in 14 days']);
});

test('S5: S4 holds, so the final exit is reported; a passing window has no unmet items', () => {
  const base = { entries: daily(), freezes: [hostFreeze], selfSourcedClosed: closed(3) };
  const short = stage(run(base));
  assert.equal(short.stage, 5);
  assert.deepEqual(short.unmet, ['final exit: merged-prs']);
  assert.deepEqual(stage(run({ ...base, merged: merges(6) })).unmet, []);
});

test('more than 20% not-planned or duplicate closures keeps stage 4', () => {
  const mixed = [...closed(4), ...closed(1, 'not_planned')];
  assert.equal(stage(run({ entries: daily(), freezes: [hostFreeze], selfSourcedClosed: mixed })).stage, 5);
  const bad = [...closed(3), ...closed(1, 'duplicate')];
  assert.equal(stage(run({ entries: daily(), freezes: [hostFreeze], selfSourcedClosed: bad })).stage, 4);
});

test('a capability is self when there was no counted intervention in the last 14 days', () => {
  const s = stage(run({ entries: [ownerEntry(NOW - 20 * DAY, 'liveness'), ownerEntry(NOW - 3 * DAY, 'decision'), ownerEntry(NOW - 10 * DAY, 'merge'), daily()[0]] }));
  assert.equal(s.capabilities.L, 'self');
  assert.equal(s.capabilities.D, 'external');
  assert.equal(s.capabilities.M, 'external');
  assert.equal(s.capabilities.H, 'self');
});

test('MTBI is U(W) / I(W) with two counted interventions in the window', () => {
  const s = stage(run({ entries: [ownerEntry(NOW - 6 * HOUR, 'merge'), ownerEntry(NOW - 2 * HOUR, 'merge'), daily()[0]] }));
  assert.deepEqual(s.mtbi, { value: 84, bound: null });
});

// Heartbeat fixtures: a valid heartbeat file body with the given write and cycle times; the verdict reads lastCycleAt.
const heartbeatBody = (lastCycleAt, writtenAt = NOW) => JSON.stringify({
  schemaVersion: 1, writtenAt, daemon: { pid: 1, lastCycleAt, state: 'running' },
  frontChief: { session: 'none', lastTurnAt: 0, state: 'gone' }, lastMaterialProgress: null,
});
const verdictOf = (text, freezes = []) => heartbeatVerdict({ heartbeat: parseHeartbeat(text), freezes, now: NOW });
const FRESH_MS = 3 * DEFAULT_POLL_MS;

test('heartbeatVerdict: missing file or invalid heartbeat is missing', () => {
  assert.equal(verdictOf(undefined), 'missing');
  assert.equal(verdictOf('{not json'), 'missing');
  assert.equal(verdictOf(JSON.stringify({ writtenAt: NOW, daemon: { lastCycleAt: NOW } })), 'missing');
});

test('heartbeatVerdict: a cycle within 3 poll intervals is fresh', () => {
  assert.equal(verdictOf(heartbeatBody(NOW - FRESH_MS)), 'fresh');
});

test('heartbeatVerdict: an old cycle with no covering host-freeze is stale', () => {
  assert.equal(verdictOf(heartbeatBody(NOW - FRESH_MS - 1)), 'stale');
  assert.equal(verdictOf(heartbeatBody(NOW - FRESH_MS - 1), [{ start: NOW - 2 * HOUR, end: NOW, class: 'scheduler-stall' }]), 'stale');
});

test('heartbeatVerdict: an old cycle covered by a host-freeze as the last ledger entry is host-freeze', () => {
  const lastCycleAt = NOW - 2 * HOUR;
  const freezes = [{ start: lastCycleAt - HOUR, end: lastCycleAt + 1, class: 'host-freeze' }];
  assert.equal(verdictOf(heartbeatBody(lastCycleAt), freezes), 'host-freeze');
  assert.equal(verdictOf(heartbeatBody(lastCycleAt), [...freezes, { start: NOW - HOUR, end: NOW, class: 'scheduler-stall' }]), 'stale');
});

test('observer mode denies every actuator action and allows only the read and record operations', () => {
  assert.equal(observer.stage, 5);
  assert.deepEqual(observer.denied, [...ALLOWED_ACTIONS]);
  for (const action of ALLOWED_ACTIONS) assert.equal(observerAllows(action), false, action);
  for (const action of observer.allowed) assert.equal(observerAllows(action), true, action);
  assert.equal(observerAllows('merge'), false);
  assert.equal(observerAllows('unknown-action'), false);
});

// CLI tests: a temp workspace whose clock is the real one, so the window always holds the fixture entries.
const T = Date.now();
const passingEntries = () => [selfEntry(T - HOUR), selfEntry(T - 25 * HOUR), selfEntry(T - 49 * HOUR)];

async function workspace(t, { entries = passingEntries(), merged = 6, selfClosed = 1, heartbeat = heartbeatBody(T, T), freezeLines = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rt-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, '.roundtable', 'state');
  await mkdir(state, { recursive: true });
  const lines = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(join(state, 'interventions.jsonl'), lines(entries));
  await writeFile(join(state, 'merges.log'), lines(Array.from({ length: merged }, (_, i) => ({ at: iso(T - (i + 1) * HOUR), kind: 'merge' }))));
  await writeFile(join(state, 'self-closed.log'), lines(Array.from({ length: selfClosed }, (_, i) => ({ at: iso(T - (i + 1) * HOUR) }))));
  await writeFile(join(state, 'heartbeat.json'), heartbeat);
  await writeFile(join(state, 'freeze-ledger.jsonl'), lines(freezeLines));
  return root;
}
const cli = (root, ...args) => spawnSync(process.execPath, [CLI, '--workspace', root, ...args], { encoding: 'utf8' });
const failing = (stdout) => stdout.split('\n').filter((line) => / fail /.test(line)).map((line) => line.match(/condition=(\S+)/)[1]);

test('CLI default output is one JSON line with the stage fields', async (t) => {
  const r = cli(await workspace(t));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ['stage', 'streakHours', 'mtbi', 'capabilities', 'unmet']);
  assert.equal(out.stage, 1); // three days of entries: the 7-day coverage measure is unmet
});

test('--exit passes when all five conditions hold and prints no paths', async (t) => {
  const root = await workspace(t);
  const r = cli(root, '--exit');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /condition=merged-prs ok value=6/);
  assert.match(r.stdout, /exit: pass\n$/);
  assert.ok(!r.stdout.includes(root));
});

test('--exit fails on counted interventions and names the condition; owner-only does not count', async (t) => {
  const r = cli(await workspace(t, { entries: [...passingEntries(), ownerEntry(T - 2 * HOUR, 'decision')] }), '--exit');
  assert.equal(r.status, 1);
  assert.deepEqual(failing(r.stdout), ['interventions']);
  const ok = cli(await workspace(t, { entries: [...passingEntries(), ownerEntry(T - 2 * HOUR, 'owner-only')] }), '--exit');
  assert.equal(ok.status, 0, ok.stdout);
});

test('--exit fails when fewer than minMergedPrs merges', async (t) => {
  const r = cli(await workspace(t, { merged: 5 }), '--exit');
  assert.equal(r.status, 1);
  assert.deepEqual(failing(r.stdout), ['merged-prs']);
});

test('--exit fails when no self-sourced issue was closed by a merged PR', async (t) => {
  const r = cli(await workspace(t, { selfClosed: 0 }), '--exit');
  assert.equal(r.status, 1);
  assert.deepEqual(failing(r.stdout), ['self-sourced-completed']);
});

test('--exit fails on a stale heartbeat with no covering host-freeze', async (t) => {
  const r = cli(await workspace(t, { heartbeat: heartbeatBody(T - FRESH_MS - 1, T) }), '--exit');
  assert.equal(r.status, 1);
  assert.deepEqual(failing(r.stdout), ['freezes']);
});

test('--exit fails on a scheduler-stall that has not ended by the check time', async (t) => {
  const stall = { start: T - 2 * HOUR, end: T + HOUR, class: 'scheduler-stall' };
  const r = cli(await workspace(t, { freezeLines: [stall] }), '--exit');
  assert.equal(r.status, 1);
  assert.deepEqual(failing(r.stdout), ['freezes']);
});

test('--exit passes when a scheduler-stall is followed by a cycle, and fails when no cycle follows it', async (t) => {
  const ok = cli(await workspace(t, { freezeLines: [{ start: T - 3 * HOUR, end: T - 2 * HOUR, class: 'scheduler-stall' }], heartbeat: heartbeatBody(T - 1000) }), '--exit');
  assert.equal(ok.status, 0, ok.stdout);
  const stall = { start: T - 3 * HOUR, end: T - 10 * 60_000, class: 'scheduler-stall' };
  const bad = cli(await workspace(t, { freezeLines: [stall], heartbeat: heartbeatBody(T - 12 * 60_000) }), '--exit');
  assert.equal(bad.status, 1);
  assert.deepEqual(failing(bad.stdout), ['freezes']);
});

test('--exit fails when a 24 h slice of the window has no self entry', async (t) => {
  const r = cli(await workspace(t, { entries: [selfEntry(T - HOUR), selfEntry(T - 25 * HOUR)] }), '--exit');
  assert.equal(r.status, 1);
  assert.deepEqual(failing(r.stdout), ['recording']);
});
