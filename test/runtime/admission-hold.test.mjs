import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GAP_CLAIM_HOLD_MS, admissionHold, readAdmissionConfig, readMemAvailableMiB, readPsiSomeAvg60, validateGovernor } from '../../runtime/lib/governor.mjs';
import { LEDGER_PATH, runLoop } from '../../runtime/lib/daemon-loop.mjs';
import { runQueue } from './observation-fixture.mjs';

const ADMISSIBLE = '## Goal\nFixture task.\n\n## Acceptance criteria\nRun: `node --test test/runtime/rtd-cleanup.test.mjs`; Expected: exit 0.\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 10\nFiles: 1';

const START = 1_700_000_000_000;
const DEFAULT_ADMISSION = { loadPerCpu: 1, minAvailableMiB: 2500, maxMemPsi: 10 };
const CALM = { load1: 0.1, cpus: 2, memAvailableRatio: 0.9, memAvailableMiB: 8000, memPsiAvg60: 0 };
const LOAD_HOT = { ...CALM, load1: 3 };
const MEM_LOW = { ...CALM, memAvailableMiB: 2000 };
const PSI_HIGH = { ...CALM, memPsiAvg60: 12 };

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-admit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeClock() {
  let wall = START, mono = 0;
  return { wall: () => wall, mono: () => mono, advance: (ms) => { wall += ms; mono += ms; } };
}

const fakeSleep = (clock) => async (ms) => clock.advance(ms);

test('MemAvailable is read in MiB; missing or malformed values give undefined', () => {
  assert.equal(readMemAvailableMiB('MemTotal:       16000000 kB\nMemAvailable:    2048000 kB\n'), 2000);
  assert.equal(readMemAvailableMiB('MemTotal:       16000000 kB\n'), undefined);
  assert.equal(readMemAvailableMiB('MemAvailable: abc kB\n'), undefined);
  assert.equal(readMemAvailableMiB(undefined), undefined);
});

test('PSI some avg60 is read from the some line only; missing gives undefined', () => {
  const text = 'some avg10=1.00 avg60=12.34 avg300=0.50 total=1234\nfull avg10=0.00 avg60=99.00 avg300=0.00 total=0\n';
  assert.equal(readPsiSomeAvg60(text), 12.34);
  assert.equal(readPsiSomeAvg60('full avg10=0.00 avg60=99.00 avg300=0.00 total=0\n'), undefined);
  assert.equal(readPsiSomeAvg60(undefined), undefined);
});

test('admissionHold names each signal above its threshold; a calm sample holds nothing', () => {
  assert.deepEqual(admissionHold(CALM, DEFAULT_ADMISSION), []);
  assert.deepEqual(admissionHold(LOAD_HOT, DEFAULT_ADMISSION), ['load']);
  assert.deepEqual(admissionHold(MEM_LOW, DEFAULT_ADMISSION), ['memAvailable']);
  assert.deepEqual(admissionHold(PSI_HIGH, DEFAULT_ADMISSION), ['memPsi']);
  assert.deepEqual(admissionHold({ ...CALM, load1: 3, memAvailableMiB: 2000, memPsiAvg60: 12 }, DEFAULT_ADMISSION), ['load', 'memAvailable', 'memPsi']);
});

test('a signal with an undefined sample value does not hold (fail open)', () => {
  assert.deepEqual(admissionHold({ load1: 0.1, cpus: 2, memAvailableRatio: 0.5 }, DEFAULT_ADMISSION), []);
  assert.deepEqual(admissionHold({ load1: 0.1, cpus: 2, memAvailableMiB: undefined, memPsiAvg60: undefined }, DEFAULT_ADMISSION), []);
});

test('the gap claim hold is five minutes', () => {
  assert.equal(GAP_CLAIM_HOLD_MS, 5 * 60_000);
});

test('validateGovernor accepts an admission block and rejects non-positive or unknown keys', () => {
  const base = { min: 1, max: 4, load: { high: 1.5, low: 0.8 }, memory: { minRatio: 0.1, okRatio: 0.2 } };
  assert.doesNotThrow(() => validateGovernor({ ...base, admission: DEFAULT_ADMISSION }));
  assert.throws(() => validateGovernor({ ...base, admission: { ...DEFAULT_ADMISSION, maxMemPsi: 0 } }), /admission\.maxMemPsi/);
  assert.throws(() => validateGovernor({ ...base, admission: { ...DEFAULT_ADMISSION, extra: 1 } }), /admission\.extra/);
});

test('readAdmissionConfig uses the defaults file, falls back per key, and falls back wholesale when the file is missing or not JSON', async (t) => {
  const dir = await tmp(t);
  const file = join(dir, 'governor.json');
  const defaults = JSON.parse(readFileSync(new URL('../../runtime/defaults/governor.json', import.meta.url), 'utf8'));
  assert.deepEqual(readAdmissionConfig(), defaults.admission);
  assert.deepEqual(readAdmissionConfig(join(dir, 'absent.json')), DEFAULT_ADMISSION);
  await writeFile(file, '{ not json');
  assert.deepEqual(readAdmissionConfig(file), DEFAULT_ADMISSION);
  await writeFile(file, JSON.stringify({ admission: { loadPerCpu: '2', minAvailableMiB: -5, maxMemPsi: 4 } }));
  assert.deepEqual(readAdmissionConfig(file), { loadPerCpu: 1, minAvailableMiB: 2500, maxMemPsi: 4 });
});

test('the pass receives claimHold for load, low MemAvailable or memory PSI above threshold, and false when all are under', async (t) => {
  const holds = [], root = await tmp(t);
  for (const sample of [LOAD_HOT, MEM_LOW, PSI_HIGH, CALM]) {
    const ac = new AbortController(), clock = fakeClock();
    await runLoop({
      pass: async ({ claimHold }) => { holds.push(claimHold); ac.abort(); },
      pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3,
      wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal, sample: () => sample,
    });
  }
  assert.deepEqual(holds, [true, true, true, false]);
});

test('a cycle gap above 3x poll holds claims for five minutes from the cycle that sees it; the gap is still recorded', async (t) => {
  t.mock.method(console, 'error', () => {});
  const clock = fakeClock(), root = await tmp(t), ac = new AbortController();
  const seen = [];
  let passes = 0;
  await runLoop({
    pass: async ({ claimHold }) => {
      seen.push({ at: clock.wall() - START, claimHold });
      if (++passes === 1) clock.advance(60_000); // 60 s stall before the first wait: a scheduler-stall gap
      if (clock.wall() - START >= 400_000) ac.abort();
    },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3,
    wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal, sample: () => CALM,
  });
  const held = seen.filter((s) => s.at >= 61_000 && s.at < 361_000);
  assert.ok(held.length > 0);
  assert.ok(held.every((s) => s.claimHold));
  assert.equal(seen.find((s) => s.at === 0).claimHold, false);
  assert.ok(seen.filter((s) => s.at >= 361_000).every((s) => !s.claimHold));
  const ledger = readFileSync(join(root, LEDGER_PATH), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(ledger, [{ start: START, end: START + 61_000, class: 'scheduler-stall' }]);
});

test('the throttle line is logged once per reason per 10 minutes; a changed reason logs again', async (t) => {
  const lines = [];
  t.mock.method(console, 'error', (line) => lines.push(line));
  const root = await tmp(t), ac = new AbortController(), clock = fakeClock();
  const samples = [LOAD_HOT, LOAD_HOT, MEM_LOW, LOAD_HOT];
  let k = 0;
  await runLoop({
    pass: async () => { if (k === samples.length) ac.abort(); },
    pollMs: 300_000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3,
    wall: clock.wall, mono: clock.mono, sleep: fakeSleep(clock), signal: ac.signal, sample: () => samples[k++],
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^INFO throttle: reason=load /);
  assert.match(lines[1], /^INFO throttle: reason=memAvailable /);
  assert.match(lines[2], /^INFO throttle: reason=load /);
});

test('under claimHold a new GitHub-tracked issue is skipped as resource_hold and no claim is made; without it the issue is claimed', async (t) => {
  const root = await tmp(t), repo = join(root, 'repo');
  process.env.RTW_STATE_DIR = await mkdtemp(join(tmpdir(), 'rt-admit-anchor-'));
  t.after(() => rm(process.env.RTW_STATE_DIR, { recursive: true, force: true }));
  await mkdir(repo);
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
  git('init', '-b', 'main'); git('commit', '--allow-empty', '-m', 'initial');
  const issue = { id: '7', number: 7, state: 'OPEN', author: { login: 'owner' }, title: '[A] issue 7', labels: [], comments: [], body: ADMISSIBLE };
  const comments = [];
  const github = { createComment: async (_n, body) => { comments.push(body); }, addLabel: async () => {}, removeLabel: async () => {}, listComments: async () => [] };
  const run = (claimHold) => runQueue({ workRoot: join(root, `work-${claimHold}`), repoRoot: repo, githubClient: github, queue: [issue], handler: async () => ({ exitCode: 0, output: 'ok' }), claimHold, models: {}, workers: 1 });

  const held = await run(true);
  assert.deepEqual(held.skipped, [{ id: '7', reason: 'resource_hold' }]);
  assert.equal(comments.length, 0);

  await run(false);
  assert.equal(comments.length, 1);
});
