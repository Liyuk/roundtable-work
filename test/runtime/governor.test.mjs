import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGovernor, readMemAvailableRatio, validateGovernor } from '../../runtime/lib/governor.mjs';
import { runLoop } from '../../runtime/lib/daemon-loop.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';

const START = 1_700_000_000_000;
const CONFIG = { min: 1, max: 4, load: { high: 1.5, low: 0.8 }, memory: { minRatio: 0.1, okRatio: 0.2 } };
const HOT = { load1: 10, cpus: 2, memAvailableRatio: 0.5 };
const COOL = { load1: 0.1, cpus: 2, memAvailableRatio: 0.9 };

async function tmp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-gov-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeClock() {
  let wall = START, mono = 0;
  return { wall: () => wall, mono: () => mono, advance: (ms) => { wall += ms; mono += ms; } };
}

test('two consecutive hot cycles step the cap down once; three cool cycles step it up once; clamped to [min, max]', () => {
  const gov = createGovernor(CONFIG);
  assert.equal(gov.step(HOT), 4);
  assert.equal(gov.step(HOT), 3);
  assert.equal(gov.step(COOL), 3);
  assert.equal(gov.step(COOL), 3);
  assert.equal(gov.step(COOL), 4);
  assert.equal(gov.step(COOL), 4);
  assert.equal(gov.step(COOL), 4); // clamped at max
  for (let i = 0; i < 6; i++) gov.step(HOT);
  assert.equal(gov.step(HOT), 1); // clamped at min
});

test('memory below minRatio counts as hot even with idle load', () => {
  const gov = createGovernor(CONFIG);
  const lowMem = { load1: 0, cpus: 2, memAvailableRatio: 0.05 };
  gov.step(lowMem);
  assert.equal(gov.step(lowMem), 3);
});

test('alternating hot and cool cycles do not change the cap', () => {
  const gov = createGovernor(CONFIG);
  const seen = [];
  for (let i = 0; i < 10; i++) seen.push(gov.step(i % 2 ? COOL : HOT));
  assert.deepEqual([...new Set(seen)], [4]);
});

test('governor.json is valid; bad configs are rejected with the offending key name', () => {
  assert.doesNotThrow(() => validateGovernor(JSON.parse(readFileSync(new URL('../../runtime/defaults/governor.json', import.meta.url), 'utf8'))));
  const bad = [
    [{ ...CONFIG, extra: 1 }, 'extra'],
    [{ ...CONFIG, load: { high: 1.5, low: 0.8, mid: 1 } }, 'load.mid'],
    [{ ...CONFIG, load: { high: 1, low: 1 } }, 'load.low'],
    [{ ...CONFIG, memory: { minRatio: 0.3, okRatio: 0.2 } }, 'memory.minRatio'],
    [{ ...CONFIG, min: 5, max: 4 }, 'min'],
  ];
  for (const [config, key] of bad) assert.throws(() => validateGovernor(config), (error) => error instanceof TypeError && error.message.includes(key), key);
});

test('readMemAvailableRatio parses MemAvailable over MemTotal and falls back when text is missing or malformed', () => {
  const meminfo = 'MemTotal:       16000000 kB\nMemFree:         1000000 kB\nMemAvailable:    4000000 kB\n';
  assert.equal(readMemAvailableRatio(meminfo, 0.99), 0.25);
  assert.equal(readMemAvailableRatio(undefined, 0.42), 0.42);
  assert.equal(readMemAvailableRatio('garbage', 0.42), 0.42);
  assert.equal(readMemAvailableRatio('MemTotal: 100 kB\n', 0.42), 0.42);
});

test('runLoop passes the governor cap, stepped by hot cycles, to the pass', async (t) => {
  const clock = fakeClock(), root = await tmp(t), ac = new AbortController();
  const seen = [];
  await runLoop({
    pass: async ({ workers }) => { seen.push(workers()); if (seen.length === 4) ac.abort(); },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 3,
    wall: clock.wall, mono: clock.mono, sleep: async (ms) => clock.advance(ms), signal: ac.signal,
    sample: () => HOT,
  });
  assert.deepEqual(seen, [3, 2, 2, 1]);
});

test('each governor cap change appends one self resource entry; unchanged cap appends nothing', async (t) => {
  const clock = fakeClock(), dir = await tmp(t), root = join(dir, '.roundtable'), ac = new AbortController();
  await mkdir(root);
  const samples = [HOT, HOT, COOL, HOT, HOT];
  let n = 0;
  await runLoop({
    pass: async () => { if (++n === samples.length) ac.abort(); },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 4,
    wall: clock.wall, mono: clock.mono, sleep: async (ms) => clock.advance(ms), signal: ac.signal,
    sample: () => samples[n],
  });
  const { entries } = openInterventions(dir).entries();
  const at1 = new Date(START + 1000).toISOString(), at2 = new Date(START + 4000).toISOString();
  assert.deepEqual(entries.map(({ at, source, category, ref, internalized, reason }) => ({ at, source, category, ref, internalized, reason })), [
    { at: at1, source: 'self', category: 'resource', ref: 'none', internalized: 'no', reason: 'load1=10 cpus=2 memAvailableRatio=0.5 from=4 to=3' },
    { at: at2, source: 'self', category: 'resource', ref: 'none', internalized: 'no', reason: 'load1=10 cpus=2 memAvailableRatio=0.5 from=3 to=2' },
  ]);
  const key = `governor:${at1}:4->3`;
  assert.equal(entries[0].id, 'iv:' + createHash('sha256').update(JSON.stringify(['self', 'resource', 'none', key])).digest('hex').slice(0, 16));
});

test('no ledger write when the work root is not inside a workspace', async (t) => {
  const clock = fakeClock(), root = await tmp(t), ac = new AbortController();
  let n = 0;
  await runLoop({
    pass: async () => { if (++n === 3) ac.abort(); },
    pollMs: 1000, cycleDeadlineMs: 5000, workRoot: root, baseWorkers: 4,
    wall: clock.wall, mono: clock.mono, sleep: async (ms) => clock.advance(ms), signal: ac.signal,
    sample: () => HOT,
  });
  assert.equal(existsSync(join(root, '.roundtable', 'state', 'interventions.jsonl')), false);
});
