import test from 'node:test';
import assert from 'node:assert/strict';
import { watchdog, WATCHDOG_RULES } from '../../../runtime/supervisor/watchdog.mjs';

const NOW = 10_000_000;
const fresh = { schemaVersion: 1, writtenAt: NOW, daemon: { pid: 1, lastCycleAt: NOW - 1000, state: 'running' },
  frontChief: { session: 'front-chief', lastTurnAt: NOW - 1000, state: 'active' },
  lastMaterialProgress: { kind: 'commit', at: NOW - 1000, ref: 'abc1234' } };
const snapshot = (overrides = {}) => ({ now: NOW, heartbeat: { ok: true, value: fresh }, sinceLastMaterialProgressMs: 1000, ...overrides });
const rules = (findings) => findings.map((f) => f.rule);

test('the rule list is a frozen constant that names every signal', () => {
  assert.equal(Object.isFrozen(WATCHDOG_RULES), true);
  for (const rule of ['heartbeat-stale', 'tight-retry-loop', 'budget-overflow', 'repeated-side-effect', 'ask-rate-spike',
    'gate-overturn', 'queue-starvation', 'crash-restart', 'pause-provenance-stale', 'reject-repeat']) {
    assert.ok(WATCHDOG_RULES.includes(rule), rule);
  }
});

test('a healthy snapshot yields no findings', () => {
  assert.deepEqual(watchdog({ snapshot: snapshot(), now: NOW, config: {} }), []);
});

test('a stale daemon heartbeat produces a heartbeat-stale finding with its evidence', () => {
  const hb = { ...fresh, daemon: { ...fresh.daemon, lastCycleAt: NOW - 600_000 } };
  const [finding] = watchdog({ snapshot: snapshot({ heartbeat: { ok: true, value: hb } }), now: NOW, config: {} });
  assert.equal(finding.rule, 'heartbeat-stale');
  assert.equal(finding.at, NOW);
  assert.equal(finding.evidence.target, 'daemon');
  assert.equal(finding.evidence.ageMs, 600_000);
});

test('a stale front Chief heartbeat is flagged separately from the daemon', () => {
  const hb = { ...fresh, frontChief: { ...fresh.frontChief, lastTurnAt: NOW - 600_000 } };
  const findings = watchdog({ snapshot: snapshot({ heartbeat: { ok: true, value: hb } }), now: NOW, config: {} });
  assert.deepEqual(findings.map((f) => f.evidence.target), ['front-chief']);
});

test('a missing heartbeat is reported as heartbeat-stale with the parse reason', () => {
  const [finding] = watchdog({ snapshot: snapshot({ heartbeat: { ok: false, reason: 'missing' } }), now: NOW, config: {} });
  assert.equal(finding.rule, 'heartbeat-stale');
  assert.equal(finding.evidence.reason, 'missing');
});

test('two identical reject reasons produce a reject-repeat finding', () => {
  const events = [
    { type: 'reject', at: NOW - 3000, reason: 'Tests  fail' },
    { type: 'reject', at: NOW - 2000, reason: 'tests fail' },
  ];
  const [finding] = watchdog({ snapshot: snapshot(), now: NOW, config: { events } });
  assert.equal(finding.rule, 'reject-repeat');
  assert.equal(finding.evidence.count, 2);
});

test('the same findings always carry the same signature', () => {
  const events = [{ type: 'reject', at: 1, reason: 'x' }, { type: 'reject', at: 2, reason: 'x' }];
  const a = watchdog({ snapshot: snapshot(), now: NOW, config: { events } });
  const b = watchdog({ snapshot: snapshot(), now: NOW + 5, config: { events } });
  assert.equal(a[0].signature, b[0].signature);
  assert.ok(a[0].signature.length > 0);
});

test('tight retry loops come from the error-signature-repeat stall signal', () => {
  const events = [1, 2, 3].map((n) => ({ type: 'error', at: n, signature: 'E_TIMEOUT' }));
  const [finding] = watchdog({ snapshot: snapshot(), now: NOW, config: { events } });
  assert.equal(finding.rule, 'tight-retry-loop');
  assert.deepEqual(finding.evidence, { signature: 'e_timeout', count: 3 });
});

test('budget overflow comes from tokens spent without a commit', () => {
  const events = [{ type: 'tokens', at: 1, tokens: 600_000 }];
  const [finding] = watchdog({ snapshot: snapshot(), now: NOW, config: { events } });
  assert.equal(finding.rule, 'budget-overflow');
  assert.equal(finding.evidence.spent, 600_000);
});

test('repeated side effects are counted per key', () => {
  const events = [1, 2, 3].map((n) => ({ type: 'side-effect', at: n, key: 'comment:250' }));
  const [finding] = watchdog({ snapshot: snapshot(), now: NOW, config: { events } });
  assert.equal(finding.rule, 'repeated-side-effect');
  assert.deepEqual(finding.evidence, { key: 'comment:250', count: 3 });
});

test('an ask-rate spike is counted inside the window', () => {
  const events = [1, 2, 3, 4, 5].map((n) => ({ type: 'ask', at: NOW - n * 1000 }));
  const [finding] = watchdog({ snapshot: snapshot(), now: NOW, config: { events, askSpike: 5, askWindowMs: 60_000 } });
  assert.equal(finding.rule, 'ask-rate-spike');
  assert.equal(finding.evidence.count, 5);
});

test('gate 0 and gate 2 overturns are flagged', () => {
  const events = [{ type: 'overturn', at: 1, gate: 0 }, { type: 'overturn', at: 2, gate: 2 }];
  const [finding] = watchdog({ snapshot: snapshot(), now: NOW, config: { events, overturns: 2 } });
  assert.equal(finding.rule, 'gate-overturn');
  assert.equal(finding.evidence.count, 2);
});

test('repeated gate failures reuse the gate-failed-repeat stall signal as gate-overturn', () => {
  const events = [1, 2].map((n) => ({ type: 'gate', at: n, gate: 'gate1', result: 'fail' }));
  const [finding] = watchdog({ snapshot: snapshot(), now: NOW, config: { events } });
  assert.equal(finding.rule, 'gate-overturn');
});

test('queue starvation needs waiting work and no material progress for the threshold', () => {
  const stale = snapshot({ sinceLastMaterialProgressMs: 7_200_000 });
  const findings = watchdog({ snapshot: stale, now: NOW, config: { queue: { waiting: 4 }, starvationMs: 3_600_000 } });
  assert.deepEqual(rules(findings), ['queue-starvation']);
  assert.deepEqual(findings[0].evidence, { waiting: 4, sinceLastMaterialProgressMs: 7_200_000 });
  assert.deepEqual(watchdog({ snapshot: stale, now: NOW, config: { queue: { waiting: 0 }, starvationMs: 3_600_000 } }), []);
});

test('crash/restart count over the threshold is flagged', () => {
  const events = [1, 2, 3].map((n) => ({ type: 'restart', at: n }));
  const [finding] = watchdog({ snapshot: snapshot(), now: NOW, config: { events, restarts: 3 } });
  assert.equal(finding.rule, 'crash-restart');
  assert.equal(finding.evidence.count, 3);
});

test('a pause provenance older than the threshold is flagged', () => {
  const snap = snapshot({ pauseProvenance: { at: NOW - 90_000_000, ref: 'pause-1' } });
  const [finding] = watchdog({ snapshot: snap, now: NOW, config: { pauseProvenanceMaxMs: 86_400_000 } });
  assert.equal(finding.rule, 'pause-provenance-stale');
  assert.deepEqual(finding.evidence, { ref: 'pause-1', ageMs: 90_000_000 });
});

test('a recent pause provenance is not flagged', () => {
  const snap = snapshot({ pauseProvenance: { at: NOW - 1000, ref: 'pause-1' } });
  assert.deepEqual(watchdog({ snapshot: snap, now: NOW, config: { pauseProvenanceMaxMs: 86_400_000 } }), []);
});
