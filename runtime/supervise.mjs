// Supervisor entrypoint: one observe cycle per run. Apply needs live actuator adapters, which are not wired here.
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect } from './supervisor/collect.mjs';
import { watchdog } from './supervisor/watchdog.mjs';
import { dispatch } from './supervisor/modes.mjs';
import { createLedger, fileAppender, LEDGER_PATH } from './supervisor/ledger.mjs';
import { HEARTBEAT_PATH } from './supervisor/heartbeat.mjs';

/**
 * One supervisor cycle. Records a cycle root, then one or more decisions per finding, all on the root's trace.
 * Only `void-stale-pause` ever reaches the actuator, and only in apply mode.
 */
export async function runCycle({ mode = 'observe', now, collectInputs, ledger, actuator, config = {}, auditor }) {
  if (auditor && (typeof auditor.name !== 'string' || auditor.name.length === 0 || typeof auditor.audit !== 'function')) {
    throw new TypeError('auditor needs a non-empty name and an audit function');
  }
  const snapshot = { ...(await collect(collectInputs)), pauseProvenance: collectInputs.pauseProvenance };
  const findings = watchdog({ snapshot, now, config });
  const root = ledger.record({ mode, action: 'cycle', reason: `cycle: ${findings.length} finding(s)`, findingSignature: 'supervisor-cycle' });

  const pending = [];
  const decisions = [root];
  for (const finding of findings) {
    const actuatorAdapter = {
      requeue: (ref) => pending.push(actuator.act({ action: 'void-stale-pause', reason: `stale pause ${ref}`, findingSignature: finding.signature, args: { ref } })),
    };
    decisions.push(...dispatch({ mode, finding, ledger, actuator: actuatorAdapter, parentId: root.id, traceId: root.traceId }));
  }
  await Promise.all(pending);

  if (auditor) {
    const notes = await auditor.audit(Object.freeze(structuredClone(snapshot.github)));
    for (const note of notes) {
      decisions.push(ledger.record({ mode, action: 'observe-only', reason: `auditor ${auditor.name}: ${note}`, findingSignature: `auditor:${auditor.name}`, parentId: root.id, traceId: root.traceId }));
    }
  }
  return { traceId: root.traceId, rootId: root.id, mode, findings: findings.map((f) => f.rule), decisions };
}

/** Parses CLI args. Unknown flags and modes throw TypeError. */
export function parseArgs(argv) {
  const args = { mode: 'observe', workspace: undefined, issue: null, githubFixture: undefined };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--mode') {
      if (!['observe', 'apply'].includes(value)) throw new TypeError(`unknown mode: ${value}`);
      args.mode = value;
    } else if (flag === '--workspace') args.workspace = value;
    else if (flag === '--issue') {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw new TypeError('--issue must be a positive integer');
      args.issue = n;
    } else if (flag === '--github-fixture') args.githubFixture = value;
    else throw new TypeError(`unknown argument: ${flag}`);
  }
  if (!args.workspace) throw new TypeError('--workspace is required');
  return args;
}

/** Runs one observe cycle against a workspace; writes the cycle result as one JSON line to stdout. */
export async function main(argv, deps = {}) {
  const { now = Date.now, stdout = process.stdout.write.bind(process.stdout), readFile: read = readFile, mkdir: makeDir = mkdir, fileAppender: appender = fileAppender } = deps;
  const { mode, workspace, issue, githubFixture } = parseArgs(argv);
  if (mode === 'apply') throw new Error('apply needs live actuator adapters, which this entrypoint does not wire');
  if (!githubFixture) throw new Error('no GitHub source configured: pass --github-fixture; live read client is not wired');

  const fixture = JSON.parse(await read(githubFixture, 'utf8'));
  const readHeartbeat = () => read(join(workspace, HEARTBEAT_PATH), 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  });
  const github = {
    listIssues: async () => fixture.issues,
    listPulls: async () => fixture.pulls,
    listChecks: async (headSha) => fixture.checks[headSha],
    listComments: async () => fixture.comments,
  };
  const ledgerPath = join(workspace, LEDGER_PATH);
  await makeDir(dirname(ledgerPath), { recursive: true });
  const ledger = createLedger({ append: appender(ledgerPath) });
  // Observe mode: any accidental actuator call fails loudly.
  const actuator = { act: async () => { throw new Error('observe mode must not act'); } };

  const at = now();
  const result = await runCycle({
    mode,
    now: at,
    collectInputs: { now: at, issue, readHeartbeat, readDaemonState: async () => null, readDaemonLog: async () => null, github },
    ledger,
    actuator,
    config: {},
  });
  stdout(JSON.stringify(result) + '\n');
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err.message); process.exitCode = 1; });
}
