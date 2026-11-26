// Runs one self-judgment cycle against the host state under `root`: loads loop-stall.json, observes the snapshot,
// appends each firing to self-judgment.tsv, enqueues its stall-alert, and saves the state so `fired` survives restarts.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, observeCycle } from './loop-stall.mjs';
import { openOutbox } from './outbox.mjs';

export function runLoopStallCycle({ root, snapshot, config }) {
  const stateDir = join(root, '.roundtable/state');
  const stateFile = join(stateDir, 'loop-stall.json');
  mkdirSync(stateDir, { recursive: true });
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : initialState();
  const result = observeCycle({ state, snapshot, config });
  const outbox = openOutbox(root);
  for (const firing of result.firings) {
    appendFileSync(join(stateDir, 'self-judgment.tsv'), firing.ledger);
    outbox.enqueue(firing.item);
  }
  writeFileSync(stateFile, JSON.stringify(result.state, null, 2) + '\n');
  return { state: result.state, firings: result.firings };
}
