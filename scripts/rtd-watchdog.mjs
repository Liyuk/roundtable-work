#!/usr/bin/env node
// Watchdog for the rtd daemon loop: reads the heartbeat and freeze ledger and prints one JSON line.
// Without --restart it is report-only and never writes. With --restart it acts on a stale verdict: it restarts the user
// unit at most 3 times in a rolling hour, skips the restart when the watchdog itself was frozen, and enqueues one owner
// alert when the budget is spent. --require-tools checks host tools and alerts once per missing tool per UTC day.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseHeartbeat, HEARTBEAT_PATH } from '../runtime/supervisor/heartbeat.mjs';
import { LEDGER_PATH, fileLedgerStore, watchdogVerdict } from '../runtime/lib/daemon-loop.mjs';
import { openInterventions } from '../runtime/lib/interventions.mjs';
import { dispatch, openOutbox } from '../runtime/lib/outbox.mjs';
import { createGitHubOutboxProvider } from '../runtime/lib/outbox-github.mjs';
import { createGitHubWriter } from './github-read.mjs';

const HOUR_MS = 3_600_000;
const MAX_RESTARTS = 3;
const UNIT = /^[a-z0-9@._-]+\.service$/;
const TOOL = /^[a-z0-9._-]+$/;
const RESTARTS_PATH = '.roundtable/state/watchdog-restarts.jsonl';
const SAMPLE_PATH = '.roundtable/state/watchdog-sample.json';
const ALERT_ID = /^notice:(?:stall:watchdog|tool-missing):/;

export function check({ workspace, pollMs, now = Date.now() }) {
  const file = join(resolve(workspace), HEARTBEAT_PATH);
  const heartbeat = parseHeartbeat(existsSync(file) ? readFileSync(file, 'utf8') : undefined);
  const ledgerEntries = fileLedgerStore(join(resolve(workspace), LEDGER_PATH)).load();
  return watchdogVerdict({ heartbeat, ledgerEntries, now, pollMs });
}

/** Wall clock, monotonic uptime and boot id. Unlike performance.now(), /proc/uptime is comparable across processes. */
export function bootClock() {
  return {
    wall: Date.now(),
    mono: Math.round(Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]) * 1000),
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
  };
}

const runCommand = (argv) => spawnSync(argv[0], argv.slice(1), { stdio: 'ignore' }).status;
const hasTool = (name) => runCommand(['sh', '-c', 'command -v "$1"', 'sh', name]) === 0;
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
const appendJsonl = (file, entry) => { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(entry)}\n`); };
const iso = (ms) => new Date(ms).toISOString();

/**
 * One watchdog run. Returns the verdict fields plus what it did: `restart` (unit, or 'exhausted'), `skipped`,
 * `missing` (tools) and `alerts` (ids newly enqueued, only when there are some). Exit codes stay the verdict's, except
 * 4 for a missing required tool.
 */
export async function watchdog({ workspace, pollMs, restart = false, unit, alertIssue = null, requireTools = [], clock = bootClock, exec = runCommand, lookup = hasTool, writer }) {
  const root = resolve(workspace);
  const sample = restart ? clock() : undefined;
  const now = sample?.wall ?? Date.now();
  const outbox = openOutbox(root);
  const alerts = [];
  const alert = (id, body) => { if (outbox.enqueue({ id, kind: 'comment', issue: alertIssue, payload: { body } })) alerts.push(id); };
  // Only watchdog alerts are sent, and to the issue given now (an alert enqueued earlier has no issue yet).
  const finish = async (result) => {
    if (alertIssue !== null) {
      const mine = { ...outbox, pending: () => outbox.pending().filter((item) => ALERT_ID.test(item.id)).map((item) => ({ ...item, issue: alertIssue })) };
      await dispatch({ outbox: mine, provider: createGitHubOutboxProvider({ writer: writer ?? createGitHubWriter() }) });
    }
    return alerts.length > 0 ? { ...result, alerts } : result;
  };

  const missing = requireTools.filter((tool) => !lookup(tool));
  if (missing.length > 0) {
    for (const tool of missing) alert(`notice:tool-missing:${tool}:${iso(now).slice(0, 10)}`, `rt watchdog: required tool \`${tool}\` is not available on the host.`);
    return finish({ exit: 4, reason: 'tool-missing', missing });
  }

  const verdict = check({ workspace: root, pollMs, now });
  if (!restart) return finish(verdict);

  const journal = join(root, RESTARTS_PATH), samplePath = join(root, SAMPLE_PATH);
  const prior = existsSync(samplePath) ? JSON.parse(readFileSync(samplePath, 'utf8')) : undefined;
  mkdirSync(dirname(samplePath), { recursive: true });
  writeFileSync(samplePath, JSON.stringify(sample));

  const entries = readJsonl(journal);
  const since = entries.slice(entries.findLastIndex((e) => e.action === 'reset') + 1);
  if (verdict.reason === 'fresh') {
    if (since.length > 0) appendJsonl(journal, { at: now, action: 'reset' });
    return finish(verdict);
  }
  if (verdict.reason !== 'stale') return finish(verdict);
  if (existsSync(join(root, '.roundtable/state/STOP'))) return finish({ ...verdict, skipped: 'stop' });

  // The watchdog's own wall clock ran more than one poll ahead of its monotonic clock on the same boot: it was frozen,
  // so the stale heartbeat says nothing about the daemon.
  const frozen = prior?.bootId === sample.bootId && sample.wall - prior.wall - (sample.mono - prior.mono) > pollMs;
  if (frozen) {
    appendJsonl(journal, { at: now, action: 'skip', reason: 'own-freeze' });
    return finish({ ...verdict, skipped: 'own-freeze' });
  }

  const counted = since.filter((e) => e.action === 'restart' && e.at > now - HOUR_MS);
  if (counted.length >= MAX_RESTARTS) {
    const start = iso(counted[0].at);
    alert(`notice:stall:watchdog:${start}`, `rt watchdog: ${MAX_RESTARTS} restarts of \`${unit}\` in the last hour did not clear a stale heartbeat. No automatic restart until the window rolls over.`);
    openInterventions(root).append({ at: iso(now), category: 'liveness', ref: 'none', reason: 'restart-exhausted', internalized: 'no', source: 'self' }, { key: `restart-exhausted:${start}` });
    return finish({ ...verdict, restart: 'exhausted' });
  }

  const status = exec(['systemctl', '--user', 'restart', unit]);
  appendJsonl(journal, { at: now, action: 'restart', unit, status });
  openInterventions(root).append({ at: iso(now), category: 'liveness', ref: 'none', reason: `restarted ${unit} after a stale heartbeat`, internalized: 'partial', source: 'self' }, { key: `restart:${now}` });
  return finish({ ...verdict, restart: unit });
}

async function main(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, options: {
      workspace: { type: 'string' }, 'poll-ms': { type: 'string' }, restart: { type: 'boolean' }, unit: { type: 'string' },
      'alert-issue': { type: 'string' }, 'require-tools': { type: 'string' },
    } }).values;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const tools = args['require-tools']?.split(',') ?? [];
  const bad = !args.workspace || !/^[1-9]\d*$/.test(args['poll-ms'] ?? '')
    || (args.restart && !args.unit) || (args.unit !== undefined && !UNIT.test(args.unit))
    || (args['alert-issue'] !== undefined && !/^[1-9]\d*$/.test(args['alert-issue']))
    || !tools.every((tool) => TOOL.test(tool));
  if (bad) {
    console.error('usage: rtd-watchdog.mjs --workspace DIR --poll-ms N [--restart --unit NAME.service] [--alert-issue N] [--require-tools a,b]');
    return 2;
  }
  const result = await watchdog({
    workspace: args.workspace, pollMs: Number(args['poll-ms']), restart: args.restart, unit: args.unit,
    alertIssue: args['alert-issue'] === undefined ? null : Number(args['alert-issue']), requireTools: tools,
  });
  console.log(JSON.stringify(result));
  return result.exit;
}

const invoked = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2));
