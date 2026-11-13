// Deterministic stall detection over an injected event stream. Pure: the clock is `now`, and
// nothing touches fs or network. Config keys (RT_STALL_MIN is `progressMinutes`):
//   progressMinutes (RT_STALL_MIN, default 90), gateFailures (default 2),
//   heartbeatGapMs (default 120000), tokenSpend (default 500000 tokens), errorSignatures (default 3),
//   roundsNoCommit (default 3). `ledger` + `issue` make tokens-no-commit read usage-ledger rows.
// Events are sorted by `at`, ties keep input order. Each signal yields at most one stall.
// Breaker signals (error-signature-repeat, rounds-no-commit) trip a per-line breaker until answered.
import { tokensSince } from './usage-ledger.mjs';

export const STALL_SIGNALS = Object.freeze([
  'progress-stalled', 'gate-failed-repeat', 'budget-spent-blocked', 'ci-cancelled-only',
  'heartbeat-gap', 'tokens-no-commit', 'error-signature-repeat', 'rounds-no-commit',
]);
const BREAKER_SIGNALS = new Set(['error-signature-repeat', 'rounds-no-commit']);
const DEFAULTS = Object.freeze({
  progressMinutes: 90, gateFailures: 2, heartbeatGapMs: 120000, tokenSpend: 500000, errorSignatures: 3, roundsNoCommit: 3,
});
const MINUTE = 60000;
const normalize = (text) => String(text).trim().replace(/\s+/g, ' ').toLowerCase();

/** Circuit breaker for one line: tripped by a breaker stall, cleared only by answerBreaker. */
export const createBreaker = () => ({ tripped: null });
export function tripBreaker(breaker, stall) {
  if (stall.breaker === true) Object.assign(breaker, { tripped: { signature: stall.signature, at: stall.at } });
  return breaker;
}
export const breakerAllowsRetry = (breaker) => breaker.tripped === null;
export const answerBreaker = (breaker, at) => Object.assign(breaker, { tripped: null, answeredAt: at });

/** Stable identity of a stall: the same facts always produce the same signature. */
export const signatureOf = (stall) => stall.signature;

/** @returns {{ signal: string, signature: string, at: number, evidence: object }[]} */
export function detectStalls({ events = [], now, config = {}, ledger, issue, breaker }) {
  const c = { ...DEFAULTS, ...config };
  const ordered = events.map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.at - b.event.at || a.index - b.index).map(({ event }) => event);
  const ofType = (type) => ordered.filter((e) => e.type === type);
  const checks = {
    'progress-stalled': () => {
      const progress = ofType('progress');
      const baseline = progress.length ? progress.at(-1).at : ordered[0]?.at;
      return baseline !== undefined && now - baseline >= c.progressMinutes * MINUTE ? { key: baseline, evidence: { lastProgressAt: baseline } } : null;
    },
    'gate-failed-repeat': () => {
      const gates = ofType('gate');
      const last = gates.at(-1);
      let run = 0;
      for (let i = gates.length - 1; i >= 0 && gates[i].gate === last?.gate && gates[i].result === 'fail'; i -= 1) run += 1;
      return last && run >= c.gateFailures ? { key: last.gate, evidence: { gate: last.gate, failures: run } } : null;
    },
    'budget-spent-blocked': () => {
      const hit = ofType('budget').filter((e) => e.spent === true && e.status === 'rt:blocked').at(-1);
      return hit ? { key: 'rt:blocked', evidence: { at: hit.at } } : null;
    },
    'ci-cancelled-only': () => {
      const required = ofType('ci').at(-1)?.required;
      if (!Array.isArray(required) || required.length === 0 || !required.every((r) => r.status === 'cancelled')) return null;
      return { key: required.map((r) => r.name).sort().join(','), evidence: { checks: required.map((r) => r.name) } };
    },
    'heartbeat-gap': () => {
      const last = ofType('heartbeat').at(-1);
      return last && now - last.at > c.heartbeatGapMs ? { key: last.at, evidence: { lastAt: last.at, gapMs: now - last.at } } : null;
    },
    'tokens-no-commit': () => {
      const commit = ofType('commit').at(-1);
      const afterAt = commit?.at ?? -Infinity;
      const spent = ledger ? tokensSince(ledger, { issue, afterAt })
        : ofType('tokens').filter((e) => e.at > afterAt).reduce((sum, e) => sum + e.tokens, 0);
      return spent >= c.tokenSpend ? { key: commit?.sha ?? 'none', evidence: { spent } } : null;
    },
    'error-signature-repeat': () => {
      const counts = new Map();
      for (const e of ofType('error')) {
        const key = normalize(e.signature);
        const entry = counts.get(key) ?? { count: 0, first: e.at };
        counts.set(key, { ...entry, count: entry.count + 1 });
      }
      const [best] = [...counts].filter(([, v]) => v.count >= c.errorSignatures).sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first);
      return best ? { key: best[0], evidence: { signature: best[0], count: best[1].count } } : null;
    },
    'rounds-no-commit': () => {
      const commit = ofType('commit').at(-1);
      const rounds = ofType('round').filter((e) => e.at > (commit?.at ?? -Infinity)).length;
      return rounds >= c.roundsNoCommit ? { key: commit?.sha ?? 'none', evidence: { rounds } } : null;
    },
  };
  const stalls = Object.entries(checks).flatMap(([signal, check]) => {
    const hit = check();
    return hit ? [{ signal, signature: `${signal}:${hit.key}`, at: now, evidence: hit.evidence, breaker: BREAKER_SIGNALS.has(signal) }] : [];
  });
  if (breaker) stalls.forEach((stall) => tripBreaker(breaker, stall));
  return stalls;
}
