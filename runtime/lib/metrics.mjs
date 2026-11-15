// Loop health metrics (#337, `rt metrics`). `computeMetrics` is pure: sources and the window are data, with no clock and
// no fs. The thin tail (`loadMetricSources`, `runMetrics`) reads the work root and formats the report.
//
// Window: [since, until) in epoch ms. Days are UTC. A source that is absent gives { na: reason }, never 0.
// Definitions:
// - owner pull-backs: owner comments received in the period that carry an approve/reject reply (a reply to ask) or
//   arrive after the issue's terminal time (its merged entry, or a terminal_closed last event). One count per comment.
// - first-dispatch success: dispatched = issues whose first implementer call (developer or fixer role) falls in the
//   period. Succeeded = dispatched issues whose only implementer call is followed by a passing review (gate1 passed).
//   rate = succeeded / dispatched.
// - wakes per issue: attempts.wakes of issues whose last event is in the period. The counter is not timestamped: total only.
// - fix rounds: implementer calls after an issue's first implementer call, counted by call day.
// - gate-fail verdicts, quota-idle cycles and time: n/a. Verdicts and quota waits are not persisted as history.
// - frozen: freeze-ledger time clipped to the period (#333), split into host-freeze and scheduler-stall; entries overlapping.
// - time-weighted concurrency: model-call time (wallMs ending at `at`) clipped to the period, divided by period length.
// - tokens per merged PR: input+output tokens of usageKnown calls on issues with a merged entry, divided by the merged
//   PR count. usageKnownShare = usageKnown calls / all calls on those issues. issuesWithoutUsage counts merged issues with no calls.
// - asks: one ask (issue + key) counts once. supervisorHeld = asks with any supervisor-route record (policy or timeout
//   default), timed at the earliest such record. ownerInterruptions = asks with only owner-route records, timed at the
//   earliest. Source: the ask ledger (ask-ledger.mjs). Absent ledger: n/a.
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createStateStore } from './state.mjs';
import { loadUsageLedger } from './usage-ledger.mjs';
import { fileLedgerStore } from './daemon-loop.mjs';

const DAY = 86_400_000;
const IMPLEMENTER_ROLES = ['developer', 'fixer'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const NA_GATE = { na: 'gate verdicts are not persisted as history' };
const NA_QUOTA = { na: 'quota waits are not persisted' };

export const na = (reason) => ({ na: reason });
const sum = (values) => values.reduce((a, b) => a + b, 0);
const inPeriod = (t, p) => t >= p.lo && t < p.hi;
const overlap = (start, end, p) => Math.max(0, Math.min(end, p.hi) - Math.max(start, p.lo));
const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const terminalAt = (issue) => Math.min(
  ...issue.ledger.filter((e) => e.type === 'merged').map((e) => e.at),
  issue.lastEvent?.type === 'terminal_closed' ? issue.lastEvent.at : Infinity,
);

function periodsOf(since, until) {
  const days = [];
  for (let d = Math.floor(since / DAY) * DAY; d < until; d += DAY) {
    days.push({ key: new Date(d).toISOString().slice(0, 10), lo: Math.max(d, since), hi: Math.min(d + DAY, until) });
  }
  return days;
}

/** Pure: metrics for [since, until) per UTC day and in total. Sources are arrays or null (absent). */
export function computeMetrics({ since, until, owner = null, inbox = null, issues = null, usage = null, freezes = null, asks = null }) {
  const byId = new Map((issues ?? []).map((issue) => [String(issue.id), issue]));
  // Per ask: the route and time that decide it. Supervisor-held wins over owner-held.
  const askDecisions = asks && (() => {
    const groups = new Map();
    for (const r of asks) {
      const group = groups.get(`${r.issue}\0${r.key}`) ?? {};
      group[r.route] = Math.min(group[r.route] ?? Infinity, r.at);
      groups.set(`${r.issue}\0${r.key}`, group);
    }
    return [...groups.values()].map((g) => (g.supervisor !== undefined ? { route: 'supervisor', at: g.supervisor } : { route: 'owner', at: g.owner }));
  })();
  const issueIds = [...new Set((usage ?? []).map((row) => String(row.issue)))];
  const callsOf = (id) => (usage ?? []).filter((row) => String(row.issue) === id);
  const implementerCalls = (id) => callsOf(id).filter((row) => IMPLEMENTER_ROLES.includes(row.role)).sort((a, b) => a.at - b.at);
  const ownerLc = owner?.toLowerCase();

  const measure = (p, total) => {
    const pullBacks = () => {
      if (ownerLc === undefined) return na('owner login not given (--owner)');
      if (!inbox || !issues) return na('event inbox or issue states not present');
      return inbox.filter((e) => e.kind === 'owner_comment' && String(e.payload?.author).toLowerCase() === ownerLc
        && inPeriod(e.receivedAt, p)
        && (e.payload.decision !== undefined || (byId.has(String(e.issue)) && e.receivedAt >= terminalAt(byId.get(String(e.issue)))))).length;
    };

    const dispatch = () => {
      if (!usage || !issues) return na(usage ? 'issue states not present' : 'usage ledger not present');
      let dispatched = 0;
      let succeeded = 0;
      for (const id of issueIds) {
        const calls = implementerCalls(id);
        if (!calls.length || !inPeriod(calls[0].at, p)) continue;
        dispatched += 1;
        if (calls.length === 1 && byId.get(id)?.gateRecord?.passed?.includes('gate1')) succeeded += 1;
      }
      return { succeeded, dispatched, rate: dispatched ? succeeded / dispatched : na('no dispatch in period') };
    };

    const wakes = () => {
      if (!total) return na('wake counter is not timestamped; total only');
      if (!issues) return na('issue states not present');
      const active = issues.filter((issue) => inPeriod(issue.lastEvent?.at, p)).map((issue) => issue.attempts.wakes);
      return active.length ? { median: median(active), max: Math.max(...active), issues: active.length } : na('no issue active in window');
    };

    const fixRounds = () => {
      if (!usage) return na('usage ledger not present');
      return issueIds.reduce((count, id) => count + implementerCalls(id).slice(1).filter((row) => inPeriod(row.at, p)).length, 0);
    };

    const frozen = () => {
      if (!freezes) return na('freeze ledger not present');
      const inClass = (cls) => sum(freezes.filter((e) => e.class === cls).map((e) => overlap(e.start, e.end, p)));
      return { hostFreezeMs: inClass('host-freeze'), schedulerStallMs: inClass('scheduler-stall'), entries: freezes.filter((e) => overlap(e.start, e.end, p) > 0).length };
    };

    const concurrency = () => {
      if (!usage) return na('usage ledger not present');
      return sum(usage.map((row) => overlap(row.at - row.wallMs, row.at, p))) / (p.hi - p.lo);
    };

    const tokensPerMergedPr = () => {
      if (!issues) return na('issue states not present');
      if (!usage) return na('usage ledger not present');
      const merged = issues.flatMap((issue) => issue.ledger.filter((e) => e.type === 'merged' && inPeriod(e.at, p)).map(() => issue));
      if (!merged.length) return na('no merged PR in period');
      const calls = merged.flatMap((issue) => callsOf(String(issue.id)));
      const known = calls.filter((row) => row.usageKnown === true);
      if (!known.length) return na('no usageKnown calls on merged issues');
      return {
        perPr: sum(known.map((row) => row.inputTokens + row.outputTokens)) / merged.length,
        mergedPrs: merged.length,
        usageKnownShare: known.length / calls.length,
        issuesWithoutUsage: merged.filter((issue) => !callsOf(String(issue.id)).length).length,
      };
    };

    const asksMeasure = () => {
      if (!askDecisions) return na('ask ledger not present');
      const inP = askDecisions.filter((a) => inPeriod(a.at, p));
      return { supervisorHeld: inP.filter((a) => a.route === 'supervisor').length, ownerInterruptions: inP.filter((a) => a.route === 'owner').length };
    };

    return {
      ownerPullBacks: pullBacks(),
      firstDispatchSuccess: dispatch(),
      wakesPerIssue: wakes(),
      fixRounds: fixRounds(),
      gateFailVerdicts: NA_GATE,
      quotaIdle: NA_QUOTA,
      frozen: frozen(),
      concurrency: concurrency(),
      tokensPerMergedPr: tokensPerMergedPr(),
      asks: asksMeasure(),
    };
  };

  const periods = periodsOf(since, until);
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    owner,
    days: Object.fromEntries(periods.map((p) => [p.key, measure(p, false)])),
    total: measure({ lo: since, hi: until }, true),
  };
}

/** Human-readable lines: one block per day, then the total. */
export function formatMetrics(report) {
  const flat = (value, prefix) => {
    if (value !== null && typeof value === 'object' && 'na' in value) return [`${prefix}: n/a (${value.na})`];
    if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => flat(v, `${prefix}.${k}`));
    return [`${prefix}: ${value}`];
  };
  const block = (title, metrics) => [title, ...Object.entries(metrics).flatMap(([k, v]) => flat(v, `  ${k}`))];
  return [
    `window: ${report.since} .. ${report.until}`,
    ...Object.entries(report.days).flatMap(([day, metrics]) => block(day, metrics)),
    ...block('total', report.total),
  ].join('\n');
}

const readLines = async (file) => {
  if (!existsSync(file)) return null;
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean);
};

/** Thin fs tail: reads the sources under a work root (`state/`); an absent source is null. */
export async function loadMetricSources(workRoot) {
  const state = join(workRoot, 'state');
  const lines = await readLines(join(state, 'event-inbox.jsonl'));
  const freezeFile = join(state, 'freeze-ledger.jsonl');
  const askLines = await readLines(join(state, 'ask-ledger.jsonl'));
  let names = null;
  if (existsSync(state)) names = await readdir(state);
  const usageNames = existsSync(join(state, 'usage')) ? await readdir(join(state, 'usage')) : null;
  const store = names && await createStateStore({ workRoot });
  const ids = (names ?? []).flatMap((name) => {
    const epoch = /^~([0-9a-f]+)\.epoch-\d+\.json$/.exec(name);
    const legacy = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.json$/.exec(name);
    return epoch ? [Buffer.from(epoch[1], 'hex').toString('utf8')] : legacy ? [legacy[1]] : [];
  });
  return {
    inbox: lines && lines.map((line) => JSON.parse(line)).filter((record) => record.type === undefined),
    freezes: existsSync(freezeFile) ? fileLedgerStore(freezeFile).load() : null,
    asks: askLines && askLines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }),
    issues: names && await Promise.all([...new Set(ids)].map((id) => store.load(id))),
    usage: usageNames && (await Promise.all(usageNames.filter((n) => n.endsWith('.json')).map((n) => loadUsageLedger(workRoot, n.slice(0, -5))))).flatMap((l) => l.rows),
  };
}

/** `rt metrics --since <ISO-8601> [--json] [--owner LOGIN] [--work-root DIR]`. Returns the output text. */
export async function runMetrics({ argv = [], cwd = process.cwd(), now = Date.now } = {}) {
  const { values } = parseArgs({ args: argv, options: { since: { type: 'string' }, json: { type: 'boolean' }, owner: { type: 'string' }, 'work-root': { type: 'string' } } });
  if (!values.since || !ISO.test(values.since) || !Number.isFinite(Date.parse(values.since))) {
    throw new Error('metrics requires --since <ISO-8601 timestamp>, e.g. 2026-11-15T00:00:00Z');
  }
  const since = Date.parse(values.since);
  const until = now();
  if (since >= until) throw new Error('--since must be earlier than now');
  const sources = await loadMetricSources(values['work-root'] ?? cwd);
  const report = computeMetrics({ since, until, owner: values.owner ?? null, ...sources });
  return values.json ? JSON.stringify(report, null, 2) : formatMetrics(report);
}
