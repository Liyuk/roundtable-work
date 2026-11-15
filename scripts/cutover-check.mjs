#!/usr/bin/env node
// Cutover readiness: every check must pass before the owner moves the unit from shadow to live (docs/operator-guide.md).
// Exit 0 when all checks pass, 1 when any fails (one FAIL line per failed check), 2 on usage errors.
import { readFile, readdir, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HEARTBEAT_PATH, parseHeartbeat } from '../runtime/supervisor/heartbeat.mjs';
import { LEDGER_PATH, fileLedgerStore, loopWorkspace } from '../runtime/lib/daemon-loop.mjs';
import { INBOX_PATH } from '../runtime/lib/event-inbox.mjs';
import { TIMERS_PATH } from '../runtime/lib/event-timers.mjs';
import { OUTBOX_PATH } from '../runtime/lib/outbox.mjs';

const HOUR = 3_600_000;
const REPO = fileURLToPath(new URL('../', import.meta.url));
const CYCLE = /^cycle-\d+\.jsonl$/;
const REFERENCE = /^`([^`]+)` \+ `([^`]+)` :: (.+)$/;

const readText = (file) => readFile(file, 'utf8').catch((error) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));

/** Rows of the inventory table (after the `| Tag class |` header and separator): [tag, mapping, cellCount]. */
function inventoryRows(markdown) {
  const lines = markdown.split('\n').filter((line) => line.startsWith('|'));
  const header = lines.findIndex((line) => line.startsWith('| Tag class |'));
  return lines.slice(header + 2).map((line) => {
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    return { tag: cells[0], mapping: cells[2] ?? '', cellCount: cells.length };
  });
}

/** Whether one inventory row resolves: superseded, ported with an existing test, or explicitly not needed after cutover. */
async function rowResolved({ mapping, cellCount }) {
  if (cellCount !== 3) return false;
  if (/^superseded by \S/.test(mapping)) return true;
  if (/not needed after cutover: \S/.test(mapping)) return true;
  const reference = REFERENCE.exec(mapping);
  if (!reference) return false;
  const [, runtimeFile, testFile, name] = reference;
  const runtimeText = await readText(join(REPO, runtimeFile));
  const testText = await readText(join(REPO, testFile));
  return runtimeText !== undefined && testText !== undefined && testText.includes(`test('${name}'`);
}

async function shadowCoverage(shadowDir) {
  const names = (await readdir(shadowDir).catch(() => [])).filter((name) => CYCLE.test(name));
  const mtimes = await Promise.all(names.map(async (name) => (await stat(join(shadowDir, name))).mtimeMs));
  if (mtimes.length === 0) return { name: 'shadow-coverage', ok: false, detail: 'no shadow/cycle-<n>.jsonl files' };
  const span = (Math.max(...mtimes) - Math.min(...mtimes)) / HOUR;
  return { name: 'shadow-coverage', ok: span >= 48, detail: `${span.toFixed(1)} h between the oldest and newest cycle (need 48)` };
}

/** Recent cycle lines must be decision differences, each explained by an issue listed in the explained file. */
async function shadowDiff({ shadowDir, explainedPath, now }) {
  const explainedText = await readText(explainedPath);
  let explained;
  try {
    explained = explainedText === undefined ? [] : JSON.parse(explainedText);
    if (!Array.isArray(explained) || explained.some((entry) => typeof entry?.issue !== 'string' || typeof entry.reason !== 'string' || entry.reason.trim() === '')) throw new Error('entries need a string issue and a non-empty reason');
  } catch (error) {
    return { name: 'shadow-diff', ok: false, detail: `malformed explained file ${explainedPath}: ${error.message}` };
  }
  const explainedIssues = new Set(explained.map((entry) => entry.issue));
  const names = (await readdir(shadowDir).catch(() => [])).filter((name) => CYCLE.test(name));
  const unexplained = [];
  let differences = 0;
  for (const name of names) {
    const file = join(shadowDir, name);
    if ((await stat(file)).mtimeMs < now - 24 * HOUR) continue;
    for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
      differences++;
      let entry;
      try { entry = JSON.parse(line); } catch { entry = null; }
      if (typeof entry?.issue !== 'string' || !('shadow' in entry) || !('live' in entry)) unexplained.push(`${name}: unreadable line`);
      else if (!explainedIssues.has(entry.issue)) unexplained.push(`issue ${entry.issue} (${name})`);
    }
  }
  return unexplained.length
    ? { name: 'shadow-diff', ok: false, detail: `unexplained differences in the last 24 h: ${unexplained.join(', ')}` }
    : { name: 'shadow-diff', ok: true, detail: `${differences} recent difference(s), all explained` };
}

async function heartbeat(workspace) {
  const result = parseHeartbeat(await readText(join(workspace, HEARTBEAT_PATH)));
  return result.ok
    ? { name: 'heartbeat', ok: true, detail: 'heartbeat.json parses' }
    : { name: 'heartbeat', ok: false, detail: `heartbeat.json ${result.reason}${result.field ? ` (${result.field})` : ''}` };
}

function schedulerStall({ workspace, now }) {
  const stalls = fileLedgerStore(join(workspace, LEDGER_PATH)).load()
    .filter((entry) => entry.class === 'scheduler-stall' && entry.end >= now - 24 * HOUR);
  return stalls.length
    ? { name: 'scheduler-stall', ok: false, detail: `${stalls.length} scheduler-stall entr${stalls.length === 1 ? 'y' : 'ies'} in the last 24 h` }
    : { name: 'scheduler-stall', ok: true, detail: 'no scheduler-stall in the last 24 h' };
}

async function inboxTimersOutbox(workspace) {
  const empty = [];
  for (const path of [INBOX_PATH, TIMERS_PATH, OUTBOX_PATH]) {
    const text = await readText(join(workspace, path));
    if (text === undefined || text.trim() === '') empty.push(path);
  }
  return empty.length
    ? { name: 'inbox-timers-outbox', ok: false, detail: `missing or empty: ${empty.join(', ')}` }
    : { name: 'inbox-timers-outbox', ok: true, detail: 'inbox, timers and outbox are non-empty' };
}

async function inventory(inventoryPath) {
  const rows = inventoryRows(await readFile(inventoryPath, 'utf8'));
  const failed = [];
  for (const row of rows) if (!(await rowResolved(row))) failed.push(row.tag);
  return failed.length
    ? { name: 'inventory', ok: false, detail: `unresolved host-patch rows: ${failed.join(', ')}` }
    : { name: 'inventory', ok: true, detail: `${rows.length} rows resolved` };
}

/** The readiness checks, in order. `now` is epoch milliseconds. */
export async function checkCutover({ workRoot, inventoryPath, explainedPath = join(workRoot, 'shadow', 'explained.json'), now = Date.now() }) {
  const shadowDir = join(workRoot, 'shadow');
  const workspace = dirname(resolve(workRoot));
  return [
    await shadowCoverage(shadowDir),
    await shadowDiff({ shadowDir, explainedPath, now }),
    await heartbeat(workspace),
    schedulerStall({ workspace, now }),
    await inboxTimersOutbox(workspace),
    await inventory(inventoryPath),
  ];
}

export async function main(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { 'work-root': { type: 'string' }, inventory: { type: 'string' }, explained: { type: 'string' } } }));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  if (!values['work-root'] || !values.inventory) {
    console.error('usage: cutover-check.mjs --work-root DIR --inventory FILE [--explained FILE]');
    return 2;
  }
  const workRoot = resolve(values['work-root']);
  if (!loopWorkspace(workRoot)) {
    console.error('--work-root must be a directory named .roundtable');
    return 2;
  }
  const checks = await checkCutover({
    workRoot,
    inventoryPath: resolve(values.inventory),
    ...(values.explained && { explainedPath: resolve(values.explained) }),
    now: Date.now(),
  });
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`);
  return checks.every((check) => check.ok) ? 0 : 1;
}

const invoked = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
