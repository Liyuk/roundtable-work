import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { approveExtraReviewRound, checkBudget, freshCounters, loadBudget, recordEvent, saveBudget } from '../../runtime/lib/budget.mjs';
import { loadLimits } from '../../runtime/lib/guard.mjs';

// Seams: checkBudget / recordEvent / saveBudget / loadBudget, and loadLimits for the review cap.
// Time is always injected; host limit files live in a temp dir, never in the real home.
const DEFAULTS = resolve(import.meta.dirname, '../../runtime/defaults/limits.json');
const LIMITS = { maxWakeupsPerIssue: 4, maxAttemptsPerAssignment: 2, maxReviewRoundsPerIssue: 3 };
const SECRET = 'sk-test-SECRET-456';

async function withDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'budget-test-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function record(c, kind, times, now = 0) {
  for (let i = 0; i < times; i++) c = recordEvent(c, kind, { now });
  return c;
}

test('review cap defaults to 3 and a stricter host value is honored', async () => {
  await withDir(async (dir) => {
    const none = await loadLimits({ defaultsPath: DEFAULTS, hostPath: join(dir, 'none.json') });
    assert.equal(none.limits.maxReviewRoundsPerIssue, 3);
    await writeFile(join(dir, 'host.json'), JSON.stringify({ maxReviewRoundsPerIssue: 2 }));
    const host = await loadLimits({ defaultsPath: DEFAULTS, hostPath: join(dir, 'host.json') });
    assert.equal(host.limits.maxReviewRoundsPerIssue, 2);
  });
});

test('wake, delegate, and review budgets are terminal once exhausted and never allow another attempt', () => {
  const cases = [['wake', 'wakes', 'maxWakeupsPerIssue'], ['delegate', 'delegateAttempts', 'maxAttemptsPerAssignment'], ['review', 'reviewRounds', 'maxReviewRoundsPerIssue']];
  for (const [kind, reason, key] of cases) {
    const c = record(freshCounters('223'), kind, LIMITS[key]);
    const first = checkBudget(c, LIMITS, { now: 0 });
    assert.equal(first.reason, reason, kind);
    assert.equal(first.counters.terminal, reason, kind);
    assert.equal(first.decision, kind === 'review' ? 'ask' : 'stop', kind);
    const again = checkBudget(first.counters, LIMITS, { now: 0 });
    assert.equal(again.decision, first.decision, kind);
    assert.equal(again.reason, reason, kind);
    assert.deepEqual(recordEvent(first.counters, kind, { now: 0 }), first.counters, kind);
  }
});

test('under the cap a check continues and counts are not terminal', () => {
  const r = checkBudget(record(freshCounters('223'), 'delegate', 1), LIMITS, { now: 0 });
  assert.equal(r.decision, 'continue');
  assert.equal(r.counters.terminal, null);
});

test('wall time uses the injected clock and becomes terminal when the window passes', () => {
  let t = 1_000;
  const c = recordEvent(freshCounters('223'), 'wake', { now: t });
  t += 999;
  assert.equal(checkBudget(c, LIMITS, { now: t, maxWallMs: 1000 }).decision, 'continue');
  t += 1;
  const r = checkBudget(c, LIMITS, { now: t, maxWallMs: 1000 });
  assert.equal(r.decision, 'stop');
  assert.equal(r.reason, 'wallTime');
  assert.equal(checkBudget(r.counters, LIMITS, { now: t, maxWallMs: 1000 }).decision, 'stop');
});

test('the review cap notifies the owner exactly once', () => {
  const first = checkBudget(record(freshCounters('223'), 'review', 3), LIMITS, { now: 0 });
  assert.equal(first.notifyOnce, true);
  const second = checkBudget(first.counters, LIMITS, { now: 0 });
  assert.equal(second.notifyOnce, false);
  assert.equal(checkBudget(second.counters, LIMITS, { now: 0 }).notifyOnce, false);
});

test('without owner approval the review cap stays closed', () => {
  const c = record(freshCounters('223'), 'review', 3);
  const r = checkBudget(c, LIMITS, { now: 0 });
  assert.equal(r.decision, 'ask');
  assert.equal(checkBudget(r.counters, LIMITS, { now: 0 }).decision, 'ask');
});

test('an owner-approved review round opens exactly one extra round', () => {
  const blocked = checkBudget(record(freshCounters('223'), 'review', 3), LIMITS, { now: 0 });
  const approved = approveExtraReviewRound(blocked.counters);
  assert.equal(approved.ownerExtraRoundApproved, true);
  const extra = checkBudget(approved, LIMITS, { now: 0 });
  assert.equal(extra.decision, 'continue');
  const after = checkBudget(recordEvent(extra.counters, 'review', { now: 0 }), LIMITS, { now: 0 });
  assert.equal(after.decision, 'ask');
  assert.equal(after.reason, 'reviewRounds');
  assert.equal(after.notifyOnce, false);
});

test('counters persisted to a temp file reload with identical values after a restart', async () => {
  await withDir(async (dir) => {
    const path = join(dir, '223.json');
    let c = record(freshCounters('223'), 'wake', 2, 5);
    c = recordEvent(c, 'delegate', { now: 6 });
    c = checkBudget(record(c, 'review', 3, 7), LIMITS, { now: 7 }).counters;
    await saveBudget(path, c);
    assert.deepEqual(await loadBudget(path, '223'), c);
    assert.equal((await checkBudget(await loadBudget(path, '223'), LIMITS, { now: 8 })).decision, 'ask');
    assert.deepEqual(await readdir(dir), ['223.json']);
  });
});

test('a missing state file yields fresh counters', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await loadBudget(join(dir, 'none.json'), '223'), freshCounters('223'));
  });
});

test('malformed persisted counters are rejected without echoing file content', async () => {
  await withDir(async (dir) => {
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ ...freshCounters('223'), wakes: SECRET }));
    const error = await loadBudget(path, '223').then(() => null, (err) => err);
    assert.ok(error);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(String(error.stack ?? '').includes(SECRET), false);
  });
});
