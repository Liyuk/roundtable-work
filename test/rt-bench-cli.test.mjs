import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { main } from '../scripts/rt-bench.mjs';

// Fixture window: production start 2026-11-11T08:00Z, NOW 2026-11-17T00:00Z, so the window is 136 h.
const NOW = '2026-11-17T00:00:00.000Z';
const WS = '/fixture/ws';
const STATE = join(WS, '.roundtable', 'state');
const METRICS = '/fixture/metrics';
const IDS = [
  'U1', 'U2', 'U3', 'U4', 'U5', 'U6',
  'L1', 'L2', 'L3', 'L4', 'L5',
  'I1', 'I2', 'I3', 'I4', 'I5',
  'D1', 'D2', 'D3', 'D4', 'D5',
  'Q1', 'Q2', 'Q3',
  'C1', 'C2', 'C3',
];

// Pacific (PST) decisions on 11-12, 11-14, 11-16: three episodes, more than 30 min apart.
const INTERVENTIONS = ['2026-11-12 10:00\tdecision\t#10', '2026-11-14 12:00\tdecision\t#11', '2026-11-16 06:00\tdecision\t#12'].join('\n') + '\n';
// CST (UTC+8) scheduler log: three live starts (one first, two manual), one timed-out stage (rc 124), one clean stage.
const SCHED = [
  '2026-11-12 10:00:00 CST rt-sched start pid=101 dry=False once=False',
  '2026-11-13 09:00:00 CST rt-sched start pid=102 dry=False once=False',
  '2026-11-14 09:00:00 CST rt-sched start pid=103 dry=False once=False',
  '2026-11-15 10:00:00 CST spawned worker #1 slot=1',
  '2026-11-15 10:30:00 CST worker #1 exited rc=124 state=timeout',
  '2026-11-15 11:00:00 CST spawned worker #2 slot=1',
  '2026-11-15 11:20:00 CST worker #2 exited rc=0 state=done',
  '2026-11-16 20:00:00 CST rt-sched poll ok',
].join('\n') + '\n';

function memoryIo(files = {}) {
  const io = {
    files: { ...files },
    out: '',
    err: '',
    async readText(path) {
      return path in io.files ? io.files[path] : null;
    },
    async appendText(path, text) {
      io.files[path] = (io.files[path] ?? '') + text;
    },
    stdout(text) {
      io.out += text;
    },
    stderr(text) {
      io.err += text;
    },
  };
  return io;
}

const fixtureFiles = {
  [join(STATE, 'interventions.tsv')]: INTERVENTIONS,
  [join(STATE, 'sched.log')]: SCHED,
};

test('summary table matches the doc section 9 format for the fixture', async () => {
  const io = memoryIo(fixtureFiles);
  assert.equal(await main(['--summary', '--workspace', WS, '--now', NOW], io), 0);
  const lines = io.out.trimEnd().split('\n');
  assert.equal(lines[0], '| Dim | Sub-metric | Current value | Level | Level-5 target |');
  assert.equal(lines[1], '|---|---|---|---|---|');
  const rows = lines.slice(2, 29);
  assert.equal(rows.length, 27);
  rows.forEach((row, i) => assert.match(row, new RegExp(`^\\| ${IDS[i][0]} \\| ${IDS[i]} [^|]+ \\| [^|]+ \\| \\d \\| [^|]+ \\|$`)));
  // Hand-derived: U1 = 136 h / 3 episodes; U3 = 3 live starts - 1 = 2; U5 = 1 timed-out stage.
  assert.equal(rows[0], '| U | U1 MTBI | 45.3 h | 4 | ≥72 h |');
  assert.equal(rows[2], '| U | U3 manual starts | 2 | 3 | 0 |');
  assert.equal(rows[4], '| U | U5 lost stages | 1 | 4 | 0 |');
  assert.match(lines[29], /^Scores: U \d · L \d · I \d · D \d · overall \d$/);
  assert.equal(io.files[join(STATE, 'bench.jsonl')], undefined);
});

test('daily writes exactly one row with the snapshot schema and 27 ids', async () => {
  const io = memoryIo(fixtureFiles);
  assert.equal(await main(['--daily', '--workspace', WS, '--now', NOW], io), 0);
  assert.equal(io.out, '');
  const lines = io.files[join(STATE, 'bench.jsonl')].split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '');
  const row = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(row).sort(), ['at', 'dimensions', 'ids', 'sources', 'window']);
  assert.deepEqual(Object.keys(row.ids), IDS);
  for (const id of IDS) assert.deepEqual(Object.keys(row.ids[id]).sort(), ['level', 'measurable', 'value']);
  assert.equal(row.at, NOW);
  assert.equal(row.ids.U3.value, 2);
  assert.equal(row.ids.U3.measurable, true);
});

test('empty state: all 27 ids not measurable at level 0 and shown as n/m', async () => {
  const io = memoryIo();
  await main(['--daily', '--workspace', WS, '--now', NOW], io);
  const row = JSON.parse(io.files[join(STATE, 'bench.jsonl')]);
  for (const id of IDS) assert.deepEqual([row.ids[id].level, row.ids[id].measurable], [0, false]);

  const summary = memoryIo();
  await main(['--summary', '--workspace', WS, '--now', NOW], summary);
  const rows = summary.out.split('\n').slice(2, 29);
  assert.equal(rows.length, 27);
  for (const row of rows) assert.match(row, /\| n\/m \| 0 \|/);
});

test('--metrics-dir also appends one line to the metrics file', async () => {
  const io = memoryIo(fixtureFiles);
  await main(['--daily', '--workspace', WS, '--now', NOW, '--metrics-dir', METRICS], io);
  assert.equal(io.files[join(STATE, 'bench.jsonl')].split('\n').length, 2);
  assert.equal(io.files[join(METRICS, 'bench.jsonl')], io.files[join(STATE, 'bench.jsonl')]);
});

test('no mode flag or both flags: usage on stderr and exit code 2', async () => {
  const none = memoryIo(fixtureFiles);
  assert.equal(await main(['--workspace', WS, '--now', NOW], none), 2);
  assert.match(none.err, /usage/);
  assert.equal(Object.keys(none.files).length, 2);

  const both = memoryIo(fixtureFiles);
  assert.equal(await main(['--daily', '--summary', '--workspace', WS, '--now', NOW], both), 2);
  assert.match(both.err, /usage/);
});
