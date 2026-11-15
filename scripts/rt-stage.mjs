#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadGoals } from '../runtime/lib/goals.mjs';
import { openInterventions } from '../runtime/lib/interventions.mjs';
import { exitConditions, heartbeatVerdict, stage } from '../runtime/lib/stage.mjs';
import { parseHeartbeat } from '../runtime/supervisor/heartbeat.mjs';

const { values } = parseArgs({ options: { workspace: { type: 'string' }, exit: { type: 'boolean' } } });
const readLines = async (file) => (existsSync(file) ? (await readFile(file, 'utf8')).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line)) : []);

try {
  if (!values.workspace) throw new TypeError('usage: rt-stage.mjs --workspace DIR [--exit]');
  const state = (name) => join(values.workspace, '.roundtable', 'state', name);
  const heartbeat = parseHeartbeat(existsSync(state('heartbeat.json')) ? await readFile(state('heartbeat.json'), 'utf8') : undefined);
  const freezes = await readLines(state('freeze-ledger.jsonl'));
  const now = Date.now();
  const input = {
    entries: openInterventions(values.workspace).entries().entries,
    freezes,
    heartbeatVerdict: heartbeatVerdict({ heartbeat, freezes, now }),
    lastCycleAt: heartbeat.value?.daemon.lastCycleAt,
    merged: (await readLines(state('merges.log'))).filter((line) => line.kind === 'merge'),
    selfSourcedClosed: await readLines(state('self-closed.log')),
    goals: await loadGoals(),
    now,
  };
  if (values.exit) {
    const conditions = exitConditions(input);
    for (const c of conditions) console.log(`condition=${c.name} ${c.ok ? 'ok' : 'fail'} value=${c.value}`);
    const pass = conditions.every((c) => c.ok);
    console.log(`exit: ${pass ? 'pass' : 'fail'}`);
    process.exitCode = pass ? 0 : 1;
  } else {
    console.log(JSON.stringify(stage(input)));
  }
} catch (err) {
  console.error(`rt-stage: ${err instanceof SyntaxError ? 'malformed input file' : (err.code ?? err.message)}`);
  process.exitCode = 1;
}
