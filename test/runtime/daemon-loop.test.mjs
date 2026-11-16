import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLL_MS, EXIT_CYCLE_DEADLINE, LEDGER_PATH, fileLedgerStore, loopWorkspace, runLoop, watchdogVerdict } from '../../runtime/lib/daemon-loop.mjs';
import { check as watchdogCheck } from '../../scripts/rtd-watchdog.mjs';
import { HEARTBEAT_PATH, parseHeartbeat } from '../../runtime/supervisor/heartbeat.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WATCHDOG = join(ROOT, 'scripts/rtd-watchdog.mjs');
const RTD = join(ROOT, 'runtime/rtd.mjs');
const START = 1_700_000_000_000;

// Fake clocks: wall and monotonic time advance independently, so a host freeze moves wall time only.
function fakeClock() {
  let wall = START, mono = 0;
  return {
    wall: () => wall,
    mono: () => mono,
    advance: (ms, monoMs = ms) => { wall += ms; mono += monoMs; },
  };
}
const fakeSleep = (clock) => async (ms) => clock.advance(ms, ms);
const freeze = (clock) => clock.advance(60_000, 0); // wall jump, monotonic clock does not move

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-loop-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const heartbeatOf = (root) => parseHeartbeat(readFileSync(join(root, HEARTBEAT_PATH), 'utf8'));
const ledgerOf = (root) => (existsSync(join(root, LEDGER_PATH))
  ? readFileSync(join(root, LEDGER_PATH), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  : []);
const hb = (lastCycleAt, extra = {}) => ({
  schemaVersion: 1, writtenAt: lastCycleAt,
  daemon: { pid: 1, lastCycleAt, state: 'running' },
  frontChief: { session: 'none', lastTurnAt: 0, state: 'gone' },
  lastMaterialProgress: null, ...extra,
});

test('a wall-clock jump without monotonic advance is recorded as a host-freeze at the next cycle', async (t) => {
  const clock = fakeClock(), root = await tmp(t), ac = new AbortController();
  let n = 0;
  const code = await runLoop({
    pass: async () => { if (++n === 1) freeze(clock); if (n === 2) ac.abort(); },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3,
    wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal,
  });
  assert.equal(code, 0);
  // Gap: 60 s of frozen pass time plus the 1 s bounded wait (wall 61 s, monotonic 1 s).
  assert.deepEqual(ledgerOf(root), [{ start: START, end: START + 61_000, class: 'host-freeze' }]);
});

test('a gap where both clocks advance is recorded as a scheduler-stall', async (t) => {
  const clock = fakeClock(), root = await tmp(t), ac = new AbortController();
  let n = 0;
  await runLoop({
    pass: async () => {
      if (++n === 2) clock.advance(60_000, 60_000); // slow scheduler: both clocks move together
      if (n === 3) ac.abort();
    },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3,
    wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal,
  });
  // Cycle 2 starts 1 s after cycle 1; cycle 3 starts 61 s after cycle 2 (60 s stall + 1 s wait).
  assert.deepEqual(ledgerOf(root), [{ start: START + 1000, end: START + 62_000, class: 'scheduler-stall' }]);
});

test('after three freezes in the window the next pass sees base - 1, and a restarted loop keeps that', async (t) => {
  const clock = fakeClock(), root = await tmp(t);
  const seen = [];
  const ac = new AbortController();
  let n = 0;
  const pass = async ({ workers }) => {
    seen.push(workers());
    if (++n <= 3) freeze(clock);
    if (n === 4) ac.abort();
  };
  const calm = () => ({ load1: 0, cpus: 1, memAvailableRatio: 1 });
  await runLoop({ pass, pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3, wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal, sample: calm });
  assert.deepEqual(seen, [3, 3, 3, 2]);
  assert.equal(ledgerOf(root).length, 3);

  // A new loop over the same ledger file sees the earlier freezes on its first pass.
  const again = new AbortController();
  const restarted = [];
  await runLoop({
    pass: async ({ workers }) => { restarted.push(workers()); again.abort(); },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3, wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: again.signal, sample: calm,
  });
  assert.deepEqual(restarted, [2]);
});

test('each cycle writes a running heartbeat with the cycle start, keeping the frontChief and progress fields', async (t) => {
  const clock = fakeClock(), root = await tmp(t), ac = new AbortController();
  await mkdir(join(root, '.roundtable/state'), { recursive: true });
  const prior = hb(START - 5000, { frontChief: { session: 'chief-1', lastTurnAt: START - 10, state: 'idle' }, lastMaterialProgress: { kind: 'commit', at: START - 20, ref: 'abc' } });
  await writeFile(join(root, HEARTBEAT_PATH), JSON.stringify(prior));
  const seen = [];
  let n = 0;
  await runLoop({
    pass: async () => {
      if (++n === 2) { seen.push(heartbeatOf(root).value); ac.abort(); }
    },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3, wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal,
  });
  assert.equal(seen[0].daemon.state, 'running');
  assert.equal(seen[0].daemon.lastCycleAt, START);
  assert.deepEqual(seen[0].frontChief, prior.frontChief);
  assert.deepEqual(seen[0].lastMaterialProgress, prior.lastMaterialProgress);
});

test('a pass that does not settle within cycleDeadlineMs ends the loop with exit 77 and a stopped heartbeat', async (t) => {
  const clock = fakeClock(), root = await tmp(t);
  const code = await runLoop({
    pass: () => new Promise(() => {}),
    pollMs: 1000, cycleDeadlineMs: 1, workRoot: root, baseWorkers: 3, wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock),
  });
  assert.equal(code, EXIT_CYCLE_DEADLINE);
  assert.equal(EXIT_CYCLE_DEADLINE, 77);
  const beat = heartbeatOf(root);
  assert.equal(beat.ok, true);
  assert.equal(beat.value.daemon.state, 'stopped');
  assert.equal(beat.value.daemon.lastCycleAt, START);
});

test('abort lets the running pass finish, writes stopped, starts no new pass and resolves 0', async (t) => {
  const clock = fakeClock(), root = await tmp(t), ac = new AbortController();
  let calls = 0, finished = 0;
  const code = await runLoop({
    pass: async () => { calls++; ac.abort(); finished++; },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3, wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal,
  });
  assert.equal(code, 0);
  assert.equal(calls, 1);
  assert.equal(finished, 1);
  assert.equal(heartbeatOf(root).value.daemon.state, 'stopped');
});

test('abort ends the bounded wait sleep early', async (t) => {
  const clock = fakeClock(), root = await tmp(t), ac = new AbortController();
  let calls = 0;
  const code = await runLoop({
    pass: async () => { calls++; },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3, wall: clock.wall, mono: clock.mono,
    sleep: () => { ac.abort(); return new Promise(() => {}); }, // never resolves unless the abort ends the wait
    signal: ac.signal,
  });
  assert.equal(code, 0);
  assert.equal(calls, 1);
});

test('a throwing pass writes a stopped heartbeat with the error clipped to 300 code points, then rethrows', async (t) => {
  const clock = fakeClock(), root = await tmp(t);
  const emoji = '😀'.repeat(400);
  await assert.rejects(runLoop({
    pass: async () => { throw new Error(emoji); },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3, wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock),
  }), { message: emoji });
  const daemon = heartbeatOf(root).value.daemon;
  assert.equal(daemon.state, 'stopped');
  assert.equal(daemon.error, '😀'.repeat(300));
  assert.equal(Array.from(daemon.error).length, 300);
});

test('watchdog verdict: fresh, host-freeze covering the stale gap, uncovered stall, and parse failures', () => {
  const ok = (lastCycleAt) => ({ ok: true, value: hb(lastCycleAt) });
  const base = { now: 10_000, pollMs: 1000 };
  assert.deepEqual(watchdogVerdict({ ...base, heartbeat: ok(10_000 - 3000), ledgerEntries: [] }), { exit: 0, reason: 'fresh' });
  assert.deepEqual(watchdogVerdict({ ...base, heartbeat: ok(1000), ledgerEntries: [{ start: 900, end: 1000, class: 'host-freeze' }] }), { exit: 0, reason: 'host-freeze' });
  assert.deepEqual(watchdogVerdict({ ...base, heartbeat: ok(1000), ledgerEntries: [{ start: 900, end: 1000, class: 'scheduler-stall' }] }), { exit: 3, reason: 'stale' });
  assert.deepEqual(watchdogVerdict({ ...base, heartbeat: ok(5000), ledgerEntries: [{ start: 900, end: 1000, class: 'host-freeze' }] }), { exit: 3, reason: 'stale' });
  assert.deepEqual(watchdogVerdict({ ...base, heartbeat: { ok: false, reason: 'missing' }, ledgerEntries: [] }), { exit: 3, reason: 'missing' });
  assert.deepEqual(watchdogVerdict({ ...base, heartbeat: { ok: false, reason: 'malformed' }, ledgerEntries: [] }), { exit: 3, reason: 'malformed' });
});

test('ledger load skips malformed and misshapen lines instead of throwing', async (t) => {
  const root = await tmp(t);
  const file = join(root, LEDGER_PATH);
  await mkdir(join(root, '.roundtable/state'), { recursive: true });
  await writeFile(file, 'not json\n{"start":1,"end":2,"class":"host-freeze"}\nnull\n{"x":1}\n\n');
  assert.deepEqual(fileLedgerStore(file).load(), [{ start: 1, end: 2, class: 'host-freeze' }]);
  assert.deepEqual(fileLedgerStore(join(root, 'absent.jsonl')).load(), []);
});

test('watchdog CLI exits 0 when fresh, 0 for a covered host-freeze, 3 when stale or missing, 2 on bad input, and never writes', async (t) => {
  const root = await tmp(t);
  const run = (...args) => spawnSync(process.execPath, [WATCHDOG, '--workspace', root, ...args], { encoding: 'utf8' });
  await mkdir(join(root, '.roundtable/state'), { recursive: true });

  const missing = run('--poll-ms', '1000');
  assert.equal(missing.status, 3);
  assert.equal(JSON.parse(missing.stdout).reason, 'missing');

  const hbFile = join(root, HEARTBEAT_PATH);
  await writeFile(hbFile, JSON.stringify(hb(Date.now())));
  const fresh = run('--poll-ms', '1000000');
  assert.equal(fresh.status, 0);
  assert.equal(JSON.parse(fresh.stdout).reason, 'fresh');

  await writeFile(hbFile, JSON.stringify(hb(1000)));
  await writeFile(join(root, LEDGER_PATH), `${JSON.stringify({ start: 500, end: 1000, class: 'host-freeze' })}\n`);
  const before = readFileSync(hbFile, 'utf8');
  const covered = run('--poll-ms', '1000');
  assert.equal(covered.status, 0);
  assert.equal(JSON.parse(covered.stdout).reason, 'host-freeze');
  assert.equal(readFileSync(hbFile, 'utf8'), before);

  await writeFile(hbFile, '{broken');
  const malformed = run('--poll-ms', '1000');
  assert.equal(malformed.status, 3);
  assert.equal(JSON.parse(malformed.stdout).reason, 'malformed');

  assert.equal(run('--poll-ms', '0').status, 2);
  assert.equal(spawnSync(process.execPath, [WATCHDOG, '--poll-ms', '1000'], { encoding: 'utf8' }).status, 2);
});

test('the --loop default poll interval is 300 s', () => {
  assert.equal(DEFAULT_POLL_MS, 300_000);
});

test('rtd --loop rejects non-positive or non-integer poll and deadline values with exit 2', async (t) => {
  const root = await tmp(t);
  const base = ['--work-root', root, '--queue', join(root, 'q.json'), '--handler', join(root, 'h.mjs'), '--routing', join(root, 'r.json'), '--loop'];
  for (const extra of [['--poll-ms', '0'], ['--poll-ms', 'abc'], ['--cycle-deadline-ms', '-5'], ['--cycle-deadline-ms', '1.5']]) {
    const r = spawnSync(process.execPath, [RTD, ...base, ...extra], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${extra.join(' ')}: ${r.stderr}`);
  }
});

test('the deployed --work-root <ws>/.roundtable shape writes heartbeat and ledger where the watchdog reads them', async (t) => {
  const clock = fakeClock(), ws = await tmp(t), ac = new AbortController();
  const workRoot = join(ws, '.roundtable');
  let n = 0;
  await runLoop({
    pass: async () => { if (++n === 1) freeze(clock); if (n === 2) ac.abort(); },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: loopWorkspace(workRoot), baseWorkers: 3,
    wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal,
  });
  assert.equal(heartbeatOf(ws).value.daemon.state, 'stopped');
  assert.equal(ledgerOf(ws).length, 1);
  assert.equal(existsSync(join(workRoot, '.roundtable')), false);
  assert.deepEqual(watchdogCheck({ workspace: ws, pollMs: 60_000, now: clock.wall() }), { exit: 0, reason: 'fresh' });
});

test('loopWorkspace takes the parent of a .roundtable work root and nothing else', async (t) => {
  const ws = await tmp(t);
  assert.equal(loopWorkspace(join(ws, '.roundtable')), ws);
  assert.equal(loopWorkspace(ws), undefined);
  assert.equal(loopWorkspace(join(ws, 'state')), undefined);
});

test('rtd --loop rejects a --work-root that is not a .roundtable directory with exit 2', async (t) => {
  const root = await tmp(t);
  const r = spawnSync(process.execPath, [RTD, '--work-root', root, '--queue', join(root, 'q.json'), '--handler', join(root, 'h.mjs'), '--routing', join(root, 'r.json'), '--loop'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /named \.roundtable/);
});
