import test from 'node:test';
import assert from 'node:assert/strict';
import { detectP2, detectP3, detectP4, detectP5, detectP6, detectP7, detectP8, detectP9 } from '../../runtime/lib/patrol.mjs';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

// Run a detector with the real clock and the global Date unavailable, so any hidden clock read fails the test.
function offClock(fn) {
  const RealDate = globalThis.Date;
  const forbidden = () => { throw new Error('real clock used inside a detector'); };
  globalThis.Date = new Proxy(RealDate, { construct: forbidden, get: (target, key) => (key === 'now' ? forbidden() : Reflect.get(target, key)) });
  try { return fn(); } finally { globalThis.Date = RealDate; }
}

test('P2 flags working items stale beyond 90 min: observe, then requeue once, then block', () => {
  const stale = { id: 'I1', state: 'working', since: NOW - 91 * MIN, staleHits: 0, requeued: false };
  const fresh = { id: 'I2', state: 'working', since: NOW - 89 * MIN, staleHits: 0, requeued: false };
  const done = { id: 'I3', state: 'done', since: NOW - 300 * MIN, staleHits: 0, requeued: false };
  const found = offClock(() => detectP2({ now: NOW, items: [stale, fresh, done] }));
  assert.deepEqual(found.map((f) => [f.row, f.action]), [['P2', 'observe']]);
  assert.equal(offClock(() => detectP2({ now: NOW, items: [{ ...stale, staleHits: 1 }] }))[0].action, 'requeue');
  assert.equal(offClock(() => detectP2({ now: NOW, items: [{ ...stale, staleHits: 2, requeued: true }] }))[0].action, 'block');
});

test('P3 flags an error fingerprint seen 3+ times in 6 h, not 2 or older repeats', () => {
  const at = (h) => NOW - h * 60 * MIN;
  const repeated = [{ fingerprint: 'E1', at: at(1) }, { fingerprint: 'E1', at: at(2) }, { fingerprint: 'E1', at: at(3) }];
  const found = offClock(() => detectP3({ now: NOW, errors: repeated }));
  assert.deepEqual(found.map((f) => [f.row, f.action, f.detail.count]), [['P3', 'pause_claims_file_self_issue', 3]]);
  const pair = [{ fingerprint: 'E2', at: at(1) }, { fingerprint: 'E2', at: at(2) }, { fingerprint: 'E3', at: at(7) }];
  assert.deepEqual(offClock(() => detectP3({ now: NOW, errors: pair })), []);
});

test('P4 pauses claims while main is red and reverts when the red commit is a loop merge', () => {
  const red = { state: 'red', sha: 'abc123', loopMerge: false };
  assert.equal(offClock(() => detectP4({ main: red }))[0].action, 'pause_claims');
  assert.equal(offClock(() => detectP4({ main: { ...red, loopMerge: true } }))[0].action, 'revert_candidate');
  assert.deepEqual(offClock(() => detectP4({ main: { ...red, state: 'green' } })), []);
});

test('P5 turns each leak-check hit into a redact candidate without echoing content', () => {
  const found = offClock(() => detectP5({ leakHits: [{ location: 'docs/a.md:3', kind: 'hostname' }] }));
  assert.deepEqual(found.map((f) => [f.row, f.action, f.detail]), [['P5', 'redact_candidate', { location: 'docs/a.md:3', kind: 'hostname' }]]);
  assert.deepEqual(offClock(() => detectP5({ leakHits: [] })), []);
});

test('P6 retries the decider up to 3 times, then proposes an ask-policy change', () => {
  const item = { id: 'I4', label: 'rt:ask', needsDefault: true, decideAttempts: 0 };
  assert.equal(offClock(() => detectP6({ items: [item] }))[0].action, 'retry_decider');
  assert.equal(offClock(() => detectP6({ items: [{ ...item, decideAttempts: 3 }] }))[0].action, 'ask_policy_candidate');
  assert.deepEqual(offClock(() => detectP6({ items: [{ ...item, needsDefault: false }] })), []);
  assert.deepEqual(offClock(() => detectP6({ items: [{ ...item, label: 'rt:other' }] })), []);
});

test('P7 proposes closing open issues/PRs whose verified done evidence holds', () => {
  const verified = { id: 7, kind: 'issue', state: 'open', verifiedDone: true };
  const found = offClock(() => detectP7({ items: [verified, { ...verified, id: 8, verifiedDone: false }, { ...verified, id: 9, state: 'closed' }] }));
  assert.deepEqual(found.map((f) => [f.row, f.action, f.detail.id]), [['P7', 'close_candidate', 7]]);
});

test('P8 proposes merging gated green PRs only when policy allows', () => {
  const pr = { number: 20, headSha: 'def456', state: 'open', gatesPassed: true, ci: 'green', policyAllowsMerge: true };
  const found = offClock(() => detectP8({ prs: [pr] }));
  assert.deepEqual(found.map((f) => [f.row, f.action, f.detail.number]), [['P8', 'merge_candidate', 20]]);
  assert.deepEqual(offClock(() => detectP8({ prs: [{ ...pr, policyAllowsMerge: false }, { ...pr, ci: 'red' }] })), []);
});

test('P9 flags locks and temp files older than 30 min as prune candidates', () => {
  const locks = [{ path: '.roundtable/locks/a.lock', heartbeat: NOW - 31 * MIN }, { path: '.roundtable/locks/b.lock', heartbeat: NOW - 5 * MIN }];
  const temps = [{ path: '.roundtable/scratch/x.tmp', mtime: NOW - 40 * MIN }];
  const found = offClock(() => detectP9({ now: NOW, locks, temps }));
  assert.deepEqual(found.map((f) => [f.row, f.action, f.detail.path]), [
    ['P9', 'prune_candidate', '.roundtable/locks/a.lock'],
    ['P9', 'prune_candidate', '.roundtable/scratch/x.tmp'],
  ]);
  assert.deepEqual(offClock(() => detectP9({ now: NOW, locks: [], temps: [] })), []);
});

test('the same inputs always give the same signatures, and changed inputs change them', () => {
  const cases = [
    () => detectP2({ now: NOW, items: [{ id: 'I1', state: 'working', since: NOW - 91 * MIN, staleHits: 1, requeued: false }] }),
    () => detectP3({ now: NOW, errors: [1, 2, 3].map((n) => ({ fingerprint: 'E1', at: NOW - n * MIN })) }),
    () => detectP4({ main: { state: 'red', sha: 'abc123', loopMerge: true } }),
    () => detectP5({ leakHits: [{ location: 'docs/a.md:3', kind: 'hostname' }] }),
    () => detectP6({ items: [{ id: 'I4', label: 'rt:ask', needsDefault: true, decideAttempts: 0 }] }),
    () => detectP7({ items: [{ id: 7, kind: 'issue', state: 'open', verifiedDone: true }] }),
    () => detectP8({ prs: [{ number: 20, headSha: 'def456', state: 'open', gatesPassed: true, ci: 'green', policyAllowsMerge: true }] }),
    () => detectP9({ now: NOW, locks: [{ path: '.roundtable/locks/a.lock', heartbeat: NOW - 31 * MIN }], temps: [] }),
  ];
  for (const run of cases) {
    const first = offClock(run).map((f) => f.signature);
    assert.ok(first.length > 0);
    assert.deepEqual(offClock(run).map((f) => f.signature), first);
    assert.equal(new Set(first).size, first.length);
  }
  const a = offClock(() => detectP7({ items: [{ id: 7, kind: 'issue', state: 'open', verifiedDone: true }] }))[0];
  const b = offClock(() => detectP7({ items: [{ id: 8, kind: 'issue', state: 'open', verifiedDone: true }] }))[0];
  assert.notEqual(a.signature, b.signature);
});
