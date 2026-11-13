import test from 'node:test';
import assert from 'node:assert/strict';
import { answerBreaker, breakerAllowsRetry, createBreaker, detectStalls, signatureOf, STALL_SIGNALS, tripBreaker } from '../../runtime/lib/stall.mjs';
import { createLedger, recordUsage } from '../../runtime/lib/usage-ledger.mjs';

// Each fixture feeds one signal's event stream under an injected clock; exactly one stall must result.
const MIN = 60000;
const FIXTURES = {
  'progress-stalled': { events: [{ type: 'progress', at: 0 }], now: 91 * MIN },
  'gate-failed-repeat': { events: [{ type: 'progress', at: 1000 }, { type: 'gate', at: 2000, gate: 'verify', result: 'fail' }, { type: 'gate', at: 3000, gate: 'verify', result: 'fail' }], now: 4000 },
  'budget-spent-blocked': { events: [{ type: 'progress', at: 1 }, { type: 'budget', at: 2, spent: true, status: 'rt:blocked' }], now: 3 },
  'ci-cancelled-only': { events: [{ type: 'progress', at: 1 }, { type: 'ci', at: 2, required: [{ name: 'test', status: 'cancelled' }, { name: 'lint', status: 'cancelled' }] }], now: 3 },
  'heartbeat-gap': { events: [{ type: 'progress', at: 0 }, { type: 'heartbeat', at: 0 }], now: 200000 },
  'tokens-no-commit': { events: [{ type: 'progress', at: 1 }, { type: 'tokens', at: 2, tokens: 500000 }], now: 3 },
};

for (const [signal, { events, now }] of Object.entries(FIXTURES)) {
  test(`${signal} produces exactly one stall event`, () => {
    const stalls = detectStalls({ events, now });
    assert.deepEqual(stalls.map((stall) => stall.signal), [signal]);
    assert.equal(stalls[0].at, now);
  });
}

test('same stall facts give the same signature; a pass resets the gate run', () => {
  const [first] = detectStalls({ events: FIXTURES['gate-failed-repeat'].events, now: 4000 });
  const [second] = detectStalls({ events: [...FIXTURES['gate-failed-repeat'].events].reverse(), now: 9000 });
  assert.equal(signatureOf(first), signatureOf(second));
  const reset = [...FIXTURES['gate-failed-repeat'].events, { type: 'gate', at: 3500, gate: 'verify', result: 'pass' }];
  assert.deepEqual(detectStalls({ events: reset, now: 4000 }).filter((s) => s.signal === 'gate-failed-repeat'), []);
});

test('thresholds are injectable and defaults hold below them', () => {
  assert.deepEqual(detectStalls({ events: [{ type: 'progress', at: 0 }], now: 89 * MIN }), []);
  assert.equal(detectStalls({ events: [{ type: 'progress', at: 0 }], now: 11 * MIN, config: { progressMinutes: 10 } }).length, 1);
});

test('error-signature-repeat and rounds-no-commit each produce one breaker stall; the six originals do not', () => {
  const errors = [0, 1, 2].map((i) => ({ type: 'error', at: 10 + i, signature: `  Boom   ${i % 2 ? 'x' : 'X'} ` }));
  const [err] = detectStalls({ events: errors, now: 20 });
  assert.deepEqual([err.signal, err.breaker], ['error-signature-repeat', true]);
  const rounds = [{ type: 'commit', at: 1, sha: 'a' }, { type: 'round', at: 2 }, { type: 'round', at: 3 }, { type: 'round', at: 4 }];
  const [round] = detectStalls({ events: rounds, now: 5 });
  assert.deepEqual([round.signal, round.breaker], ['rounds-no-commit', true]);
  assert.equal(detectStalls({ events: [{ type: 'round', at: 1 }, { type: 'round', at: 2 }], now: 3 }).length, 0);
  const [idle0] = detectStalls({ events: [{ type: 'progress', at: 0 }], now: 91 * MIN });
  assert.equal(idle0.breaker, false);
  assert.equal(STALL_SIGNALS.length, 8);
});

test('the breaker trips only on breaker stalls and clears only after answerBreaker', () => {
  const breaker = createBreaker();
  const [original] = detectStalls({ events: [{ type: 'progress', at: 0 }], now: 91 * MIN });
  tripBreaker(breaker, original);
  assert.equal(breakerAllowsRetry(breaker), true);
  const [round] = detectStalls({ events: [{ type: 'round', at: 1 }, { type: 'round', at: 2 }, { type: 'round', at: 3 }], now: 4 });
  tripBreaker(breaker, round);
  assert.equal(breakerAllowsRetry(breaker), false);
  assert.deepEqual(answerBreaker(breaker, 9), { tripped: null, answeredAt: 9 });
  assert.equal(breakerAllowsRetry(breaker), true);
});

test('detectStalls trips the passed breaker on breaker stalls only', () => {
  const breakerEvents = [{ type: 'round', at: 1 }, { type: 'round', at: 2 }, { type: 'round', at: 3 }];
  const breaker = createBreaker();
  detectStalls({ events: breakerEvents, now: 4, breaker });
  assert.equal(breakerAllowsRetry(breaker), false);
  assert.deepEqual(answerBreaker(breaker, 9), { tripped: null, answeredAt: 9 });
  assert.equal(breakerAllowsRetry(breaker), true);
  for (const { events, now } of Object.values(FIXTURES)) detectStalls({ events, now, breaker });
  assert.equal(breakerAllowsRetry(breaker), true);
});

test('tokens-no-commit reads a ledger-fed token stream since the last commit', () => {
  const ledger = createLedger();
  recordUsage(ledger, { issue: 218, role: 'fixer', model: 'm', inputTokens: 300000, outputTokens: 0, wallMs: 1, cost: 0, at: 1 });
  recordUsage(ledger, { issue: 218, role: 'fixer', model: 'm', inputTokens: 500000, outputTokens: 0, wallMs: 1, cost: 0, at: 5 });
  const events = [{ type: 'commit', at: 2, sha: 'c1' }];
  const stalls = detectStalls({ events, now: 6, ledger, issue: 218 });
  assert.deepEqual(stalls.map((s) => s.signal), ['tokens-no-commit']);
  assert.deepEqual(detectStalls({ events, now: 6, ledger, issue: 219 }), []);
});
