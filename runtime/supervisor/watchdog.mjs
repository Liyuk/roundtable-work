// Deterministic supervisor watchdog. Pure: `now` is the clock; no fs, network or Date.now.
// Input: `snapshot` from collect() (heartbeat, sinceLastMaterialProgressMs, optional pauseProvenance {at, ref}),
// and `config` with thresholds plus `events` (typed event rows) and `queue` ({ waiting }).
// Output: findings [{ rule, signature, at, evidence }]. A signature keys on the condition, not the time,
// so the same ongoing condition gets the same signature on every cycle.
import { detectStalls, signatureOf } from '../lib/stall.mjs';

export const WATCHDOG_RULES = Object.freeze([
  'heartbeat-stale', 'tight-retry-loop', 'budget-overflow', 'repeated-side-effect', 'ask-rate-spike',
  'gate-overturn', 'queue-starvation', 'crash-restart', 'pause-provenance-stale', 'reject-repeat',
]);

// Overlapping stall.mjs signals, mapped to watchdog rules. Other stall signals are not reported here.
const STALL_RULE = Object.freeze({
  'heartbeat-gap': 'heartbeat-stale',
  'gate-failed-repeat': 'gate-overturn',
  'tokens-no-commit': 'budget-overflow',
  'budget-spent-blocked': 'budget-overflow',
  'error-signature-repeat': 'tight-retry-loop',
  'rounds-no-commit': 'tight-retry-loop',
});
const MINUTE = 60000;
const DEFAULTS = Object.freeze({
  heartbeatStaleMs: 2 * MINUTE, rejectRepeats: 2, sideEffectRepeats: 3, askSpike: 5, askWindowMs: 60 * MINUTE,
  overturns: 2, starvationMs: 90 * MINUTE, restarts: 3, pauseProvenanceMaxMs: 24 * 60 * MINUTE,
});
const normalize = (text) => String(text).trim().replace(/\s+/g, ' ').toLowerCase();
const finding = (rule, signature, now, evidence) => ({ rule, signature, at: now, evidence });
const ofType = (events, type) => events.filter((e) => e.type === type);

/** Groups events of one type by a normalized key; returns [key, count] pairs for keys seen at least `min` times. */
const repeats = (events, type, keyOf, min) => {
  const counts = new Map();
  for (const e of ofType(events, type)) {
    const key = keyOf(e);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].filter(([, count]) => count >= min);
};

function heartbeatFindings(heartbeat, now, c) {
  if (!heartbeat.ok) return [finding('heartbeat-stale', 'heartbeat-stale:file', now, { reason: heartbeat.reason })];
  const beats = [['daemon', heartbeat.value.daemon.lastCycleAt], ['front-chief', heartbeat.value.frontChief.lastTurnAt]];
  return beats.filter(([, at]) => now - at > c.heartbeatStaleMs)
    .map(([target, at]) => finding('heartbeat-stale', `heartbeat-stale:${target}`, now, { target, lastAt: at, ageMs: now - at }));
}

/** @returns {{ rule: string, signature: string, at: number, evidence: object }[]} */
export function watchdog({ snapshot, now, config = {} }) {
  const c = { ...DEFAULTS, ...config };
  const events = config.events ?? [];
  const findings = heartbeatFindings(snapshot.heartbeat, now, c);

  for (const stall of detectStalls({ events, now, config })) {
    if (STALL_RULE[stall.signal]) findings.push(finding(STALL_RULE[stall.signal], signatureOf(stall), now, stall.evidence));
  }
  for (const [reason, count] of repeats(events, 'reject', (e) => normalize(e.reason), c.rejectRepeats)) {
    findings.push(finding('reject-repeat', `reject-repeat:${reason}`, now, { reason, count }));
  }
  for (const [key, count] of repeats(events, 'side-effect', (e) => e.key, c.sideEffectRepeats)) {
    findings.push(finding('repeated-side-effect', `repeated-side-effect:${key}`, now, { key, count }));
  }
  const asks = ofType(events, 'ask').filter((e) => now - e.at <= c.askWindowMs).length;
  if (asks >= c.askSpike) findings.push(finding('ask-rate-spike', 'ask-rate-spike', now, { count: asks, windowMs: c.askWindowMs }));

  const overturns = ofType(events, 'overturn').filter((e) => e.gate === 0 || e.gate === 2);
  if (overturns.length >= c.overturns) {
    findings.push(finding('gate-overturn', 'gate-overturn:overturn', now, { count: overturns.length, gates: [0, 2] }));
  }
  const waiting = config.queue?.waiting ?? 0;
  if (waiting > 0 && snapshot.sinceLastMaterialProgressMs >= c.starvationMs) {
    findings.push(finding('queue-starvation', 'queue-starvation', now,
      { waiting, sinceLastMaterialProgressMs: snapshot.sinceLastMaterialProgressMs }));
  }
  const restarts = ofType(events, 'restart').length;
  if (restarts >= c.restarts) findings.push(finding('crash-restart', 'crash-restart', now, { count: restarts }));

  const pause = snapshot.pauseProvenance;
  if (pause && now - pause.at > c.pauseProvenanceMaxMs) {
    findings.push(finding('pause-provenance-stale', `pause-provenance-stale:${pause.ref}`, now, { ref: pause.ref, ageMs: now - pause.at }));
  }
  return findings;
}
