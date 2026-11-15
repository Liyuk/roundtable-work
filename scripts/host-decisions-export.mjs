#!/usr/bin/env node
// Read-only exporter: a host status table (tab-separated `issue, status, attempt, timestamp, detail`, append-only)
// becomes the `--live-decisions` JSON of rtd.mjs: the last status per issue, mapped to a decision word:
// done→done, out-of-scope→out-of-scope, stop→stop, held→wait, running→wait, error→ask. Rows with any other status
// are skipped. The detail column is never read.
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DECISION = new Map([['done', 'done'], ['out-of-scope', 'out-of-scope'], ['stop', 'stop'], ['held', 'wait'], ['running', 'wait'], ['error', 'ask']]);

/** Latest decision per issue from table text; rows whose issue is not a positive integer or whose status is unmapped are skipped. */
export function exportDecisions(text) {
  const decisions = {};
  for (const line of text.split('\n')) {
    const [issue, status] = line.replace(/\r$/, '').split('\t');
    if (/^[1-9]\d*$/.test(issue) && DECISION.has(status)) decisions[issue] = DECISION.get(status);
  }
  return decisions;
}

export async function main(argv) {
  let values;
  try { ({ values } = parseArgs({ args: argv, options: { 'status-tsv': { type: 'string' }, out: { type: 'string' } } })); }
  catch (error) { console.error(error.message); return 2; }
  if (!values['status-tsv'] || !values.out) {
    console.error('usage: host-decisions-export.mjs --status-tsv FILE --out FILE');
    return 2;
  }
  // Replacement mode: a cut multi-byte sequence becomes U+FFFD instead of an exception.
  const text = new TextDecoder('utf-8').decode(await readFile(resolve(values['status-tsv'])));
  await writeFile(resolve(values.out), `${JSON.stringify(exportDecisions(text))}\n`);
  return 0;
}

const invoked = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
