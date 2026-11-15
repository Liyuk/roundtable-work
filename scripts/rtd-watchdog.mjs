#!/usr/bin/env node
// Report-only watchdog for the rtd daemon loop: reads the heartbeat and freeze ledger, prints one JSON line.
// It never restarts, signals or writes anything.
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseHeartbeat, HEARTBEAT_PATH } from '../runtime/supervisor/heartbeat.mjs';
import { LEDGER_PATH, fileLedgerStore, watchdogVerdict } from '../runtime/lib/daemon-loop.mjs';

export function check({ workspace, pollMs, now = Date.now() }) {
  const file = join(resolve(workspace), HEARTBEAT_PATH);
  const heartbeat = parseHeartbeat(existsSync(file) ? readFileSync(file, 'utf8') : undefined);
  const ledgerEntries = fileLedgerStore(join(resolve(workspace), LEDGER_PATH)).load();
  return watchdogVerdict({ heartbeat, ledgerEntries, now, pollMs });
}

function main(argv) {
  let args;
  try {
    args = parseArgs({ args: argv, options: { workspace: { type: 'string' }, 'poll-ms': { type: 'string' } } }).values;
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (!args.workspace || !/^[1-9]\d*$/.test(args['poll-ms'] ?? '')) {
    console.error('usage: rtd-watchdog.mjs --workspace DIR --poll-ms N');
    return 2;
  }
  const verdict = check({ workspace: args.workspace, pollMs: Number(args['poll-ms']) });
  console.log(JSON.stringify(verdict));
  return verdict.exit;
}

const invoked = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) process.exitCode = main(process.argv.slice(2));
