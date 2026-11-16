// Patrol on the daemon cycle (RT-S14b): runs the pure detectors of patrol.mjs on a recurring timer. Each finding is
// observed (event log only), sent to the actuator when its action is allow-listed and an actuator is injected, or
// becomes an owner-only notice. No action merges, closes or reverts.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectP2, detectP3, detectP4, detectP5, detectP6, detectP7, detectP8, detectP9 } from './patrol.mjs';
import { ALLOWED_ACTIONS } from '../supervisor/actuator.mjs';
import { openInterventions } from './interventions.mjs';

export const PATROL_TIMER = 'patrol:periodic';
const LOG = '.roundtable/state/patrol.jsonl';
const STOP = '.roundtable/state/STOP';
const DEFAULT_PATROL_MS = 30 * 60_000;
// Findings whose action has a supervisor equivalent; every other action is owner-only.
const ACTUATOR_FOR = { pause_claims: 'pause-queue', pause_claims_file_self_issue: 'pause-queue' };
// No detector input source exists yet in the runtime, so each detector runs on empty input.
export const EMPTY_PATROL_INPUTS = {
  p2: { items: [] }, p3: { errors: [] }, p4: { main: { state: 'green', sha: '', loopMerge: false } },
  p5: { leakHits: [] }, p6: { items: [] }, p7: { items: [] }, p8: { prs: [] }, p9: { locks: [], temps: [] },
};

/** Cadence from RT_PATROL_MS (positive integer milliseconds); the default is 30 min. */
export function patrolCadenceMs(env) {
  if (env.RT_PATROL_MS === undefined) return DEFAULT_PATROL_MS;
  if (!/^[1-9]\d*$/.test(env.RT_PATROL_MS)) throw new TypeError('RT_PATROL_MS must be a positive integer (milliseconds)');
  return Number(env.RT_PATROL_MS);
}

/** Registers the recurring patrol timer once; the first run is due at `now`. */
export function ensurePatrolTimer(timers, now, cadenceMs) {
  if (timers.list().some((t) => t.id === PATROL_TIMER)) return;
  timers.recurring({ id: PATROL_TIMER, at: new Date(now).toISOString(), cadenceMs, event: { kind: 'heartbeat', issue: null, payload: { job: 'patrol' } } });
}

/** One patrol cycle: runs the detectors, routes each finding, and writes the event log and the intervention ledger. */
export async function runPatrol({ root, now, inputs = EMPTY_PATROL_INPUTS, outbox, actuator }) {
  const at = new Date(now).toISOString();
  const file = join(root, LOG);
  const log = (entry) => {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at, ...entry })}\n`);
  };
  if (existsSync(join(root, STOP))) return log({ kind: 'cycle', outcome: 'skipped-stop' });
  const input = { ...EMPTY_PATROL_INPUTS, ...inputs };
  const findings = [
    ...detectP2({ now, ...input.p2 }), ...detectP3({ now, ...input.p3 }), ...detectP4(input.p4), ...detectP5(input.p5),
    ...detectP6(input.p6), ...detectP7(input.p7), ...detectP8(input.p8), ...detectP9({ now, ...input.p9 }),
  ];
  log({ kind: 'cycle', outcome: 'ran', findings: findings.length });
  const ledger = openInterventions(root);
  for (const f of findings) {
    const target = ACTUATOR_FOR[f.action];
    const route = f.action === 'observe' ? 'observe' : target && actuator && ALLOWED_ACTIONS.includes(target) ? 'actuator' : 'owner-only';
    log({ kind: 'finding', row: f.row, signature: f.signature, action: f.action, route });
    if (route === 'observe') continue;
    let outcome = 'owner-only';
    if (route === 'actuator') {
      outcome = (await actuator.act({ action: target, reason: `patrol ${f.row} finding ${f.action}`, findingSignature: f.signature })).status;
      log({ kind: 'action', row: f.row, signature: f.signature, action: target, outcome });
    } else {
      outbox.enqueue({ id: `patrol:owner:${f.signature}:${f.action}`, kind: 'notification', issue: null, payload: { subtype: 'patrol-owner-only', row: f.row, action: f.action } });
      log({ kind: 'action', row: f.row, signature: f.signature, action: f.action, outcome });
    }
    ledger.append({ at, category: route === 'actuator' ? 'liveness' : 'owner-only', ref: 'rt:patrol', reason: `patrol ${f.row} finding ${f.action}: ${route}`, internalized: 'no', source: 'self' }, { key: `${at}|${f.signature}|${f.action}` });
  }
}
