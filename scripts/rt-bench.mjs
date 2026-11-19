// rt-bench CLI (docs/autonomy-benchmark.md sections 2, 7 and 9). Reads the state ledgers, runs the 21 sub-metrics from the
// pure modules in scripts/rt-bench/, then appends one snapshot row (--daily) or prints the summary table (--summary).
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { readInterventions, readJsonRows } from './rt-bench/sources.mjs';
import { readSchedLog } from './rt-bench/sched-log.mjs';
import { computeU } from './rt-bench/metrics-u.mjs';
import { computeLI } from './rt-bench/metrics-li.mjs';
import { computeD } from './rt-bench/metrics-d.mjs';
import { computeQ } from './rt-bench/metrics-q.mjs';
import { computeC } from './rt-bench/metrics-cost.mjs';
import { score } from './rt-bench/score.mjs';

const hours = (v) => `${v.toFixed(1)} h`;
const percent = (v) => `${v.toFixed(1)}%`;
const count = (v) => `${v}`;
const ratio7 = (v) => `${v}/7`;
const oneDecimal = (v) => v.toFixed(1);
const threeDecimals = (v) => v.toFixed(3);
const integer = (v) => v.toFixed(0);
const twoDecimals = (v) => v.toFixed(2);

// Sub-metric rows in doc order: [id, name, format, Level-5 target].
const ROWS = [
  ['U1', 'MTBI', hours, '≥72 h'], ['U2', 'longest streak', hours, '≥72 h'], ['U3', 'manual starts', count, '0'],
  ['U4', 'freeze self-recovery', percent, '100%'], ['U5', 'lost stages', count, '0'], ['U6', 'self-ledger slices', ratio7, '7/7'],
  ['L1', 'days with self merge', ratio7, '7/7'], ['L2', 'self acceptance', percent, '≥80%'], ['L3', 'self share of merges', percent, '≥40%'],
  ['L4', 'external issues/day', oneDecimal, '≤3/week'], ['L5', 'idle hours', hours, '≤1 h'],
  ['I1', 'PR-shipped changes', percent, '100%'], ['I2', 'hand patches', count, '0'], ['I3', 'repeat-failure closure', percent, '100%'],
  ['I4', 'measured changes', percent, '100%'], ['I5', 'first-pass rate', threeDecimals, '≥0.95'],
  ['D1', 'decision interventions', count, '0'], ['D2', 'longest owner wait', hours, '≤4 h'], ['D3', 'self-settled', percent, '≥98%'],
  ['D4', 'rollback rate', percent, '≤2%'], ['D5', 'loop-merged share', percent, '100%'],
  ['Q1', 'rework/revert rate', percent, '≤2%'], ['Q2', '14-day survival', percent, '≥98%'], ['Q3', 'per-issue bench delta', percent, '100%'],
  ['C1', 'tokens per completed issue', integer, '≤100k'], ['C2', 'cost per completed issue', twoDecimals, '≤0.20'], ['C3', 'idle overhead tokens', integer, '≤10k'],
];

// Normalized sources: { asOf (epoch ms, undefined when no events), events }.
export async function collect(io, workspace) {
  const state = join(workspace, '.roundtable', 'state');
  const ivText = await io.readText(join(state, 'interventions.tsv'));
  const logText = await io.readText(join(state, 'sched.log'));
  const benchText = await io.readText(join(state, 'bench.jsonl'));
  const usageText = await io.readText(join(state, 'usage.jsonl'));
  const queueText = await io.readText(join(state, 'queue-snapshot.jsonl'));
  const iv = ivText === null ? null : readInterventions(ivText);
  const log = logText === null ? null : readSchedLog(logText);
  const asOf = (r) => (r?.lastSeen ? Date.parse(r.lastSeen) : undefined);
  const source = (r, kind) => ({ asOf: asOf(r), events: (r?.events ?? []).filter((e) => !kind || e.kind === kind) });
  return {
    interventions: source(iv),
    sched: source(log),
    schedStarts: source(log, 'start'),
    schedGaps: source(log, 'gap'),
    stages: source(log, 'stage'),
    benchSnapshots: readBench(benchText ?? ''),
    usage: source(readJsonRows(usageText ?? '')),
    queueSnapshot: source(readJsonRows(queueText ?? '')),
  };
}

// bench.jsonl: one snapshot row per line; malformed lines (bad JSON, no `at` date, no `ids`) are skipped.
function readBench(text) {
  const events = [];
  for (const line of text.split('\n')) {
    try {
      const { at, ids } = JSON.parse(line);
      if (Number.isFinite(Date.parse(at)) && ids) events.push({ at, ids });
    } catch {
      // Not a JSON row: skipped.
    }
  }
  return { asOf: events.length ? Math.max(...events.map((e) => Date.parse(e.at))) : undefined, events };
}

export function runBench(sources, now) {
  const results = [...computeU({ now, sources }), ...computeLI({ now, sources }), ...computeD({ now, sources }), ...computeQ({ now, sources }), ...computeC({ now, sources })];
  return { results, scores: score(results, now) };
}

export function snapshot(results, scores, sources, now) {
  return {
    at: new Date(now).toISOString(),
    window: results[0].window,
    ids: Object.fromEntries(results.map((r) => [r.id, { value: r.value, level: r.level, measurable: r.measurable }])),
    dimensions: scores,
    sources: Object.fromEntries(Object.entries(sources).map(([name, s]) => [name, s.asOf === undefined ? null : new Date(s.asOf).toISOString()])),
  };
}

export function summaryTable(row) {
  const lines = ['| Dim | Sub-metric | Current value | Level | Level-5 target |', '|---|---|---|---|---|'];
  for (const [id, name, format, target] of ROWS) {
    const { value, level, measurable } = row.ids[id];
    const shown = measurable ? format(value) : 'n/m';
    const proxy = id === 'L5' && measurable ? ' (proxy)' : '';
    lines.push(`| ${id[0]} | ${id} ${name} | ${shown}${proxy} | ${level} | ${target} |`);
  }
  const d = row.dimensions;
  lines.push(`Scores: U ${d.U} · L ${d.L} · I ${d.I} · D ${d.D} · overall ${d.overall}`);
  return lines.join('\n');
}

export async function appendDaily(io, row, { workspace, metricsDir }) {
  const line = JSON.stringify(row) + '\n';
  await io.appendText(join(workspace, '.roundtable', 'state', 'bench.jsonl'), line);
  if (metricsDir) await io.appendText(join(metricsDir, 'bench.jsonl'), line);
}

const realIo = {
  async readText(path) {
    try {
      return await readFile(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  },
  async appendText(path, text) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, text);
  },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const USAGE = 'usage: rt-bench.mjs (--daily | --summary) [--workspace DIR] [--now ISO] [--metrics-dir DIR]\n';

export async function main(argv, io = realIo) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        daily: { type: 'boolean' },
        summary: { type: 'boolean' },
        workspace: { type: 'string', default: process.cwd() },
        now: { type: 'string' },
        'metrics-dir': { type: 'string' },
      },
    }));
  } catch {
    io.stderr(USAGE);
    return 2;
  }
  const now = values.now ? Date.parse(values.now) : Date.now();
  if (Boolean(values.daily) === Boolean(values.summary) || !Number.isFinite(now)) {
    io.stderr(USAGE);
    return 2;
  }
  const sources = await collect(io, values.workspace);
  const { results, scores } = runBench(sources, now);
  const row = snapshot(results, scores, sources, now);
  if (values.summary) io.stdout(summaryTable(row) + '\n');
  else await appendDaily(io, row, { workspace: values.workspace, metricsDir: values['metrics-dir'] });
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
