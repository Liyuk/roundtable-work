import { readFile, rename, writeFile } from 'node:fs/promises';

// Per-issue budget counters. Persisted as JSON; exhaustion is terminal and never resets except by owner approval.
const KIND_KEY = { wake: 'wakes', delegate: 'delegateAttempts', review: 'reviewRounds' };
const DECISION = { wakes: 'stop', delegateAttempts: 'stop', reviewRounds: 'ask', wallTime: 'stop' };
const COUNT_KEYS = ['wakes', 'delegateAttempts', 'reviewRounds'];

export function freshCounters(id) {
  return { id, wakes: 0, delegateAttempts: 0, reviewRounds: 0, wallStartedAt: null, terminal: null, ownerExtraRoundApproved: false, notified: false };
}

// Counting happens only while not terminal; the first event starts the wall clock.
export function recordEvent(c, kind, { now }) {
  if (c.terminal) return c;
  const key = KIND_KEY[kind];
  return { ...c, [key]: c[key] + 1, wallStartedAt: c.wallStartedAt ?? now };
}

// Returns { decision, reason, notifyOnce, counters }; the caller saves `counters`.
export function checkBudget(c, limits, { now, maxWallMs = Infinity }) {
  if (!c.terminal) {
    const caps = {
      wakes: limits.maxWakeupsPerIssue,
      delegateAttempts: limits.maxAttemptsPerAssignment,
      reviewRounds: limits.maxReviewRoundsPerIssue + (c.ownerExtraRoundApproved ? 1 : 0),
    };
    const hit = Object.keys(caps).find((k) => c[k] >= caps[k])
      ?? (c.wallStartedAt !== null && now - c.wallStartedAt >= maxWallMs ? 'wallTime' : null);
    if (!hit) return { decision: 'continue', reason: 'within budget', notifyOnce: false, counters: c };
    c = { ...c, terminal: hit };
  }
  const notifyOnce = c.terminal === 'reviewRounds' && !c.notified;
  return { decision: DECISION[c.terminal], reason: c.terminal, notifyOnce, counters: notifyOnce ? { ...c, notified: true } : c };
}

export function approveExtraReviewRound(c) {
  return { ...c, ownerExtraRoundApproved: true, terminal: c.terminal === 'reviewRounds' ? null : c.terminal };
}

export async function saveBudget(path, c) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(c));
  await rename(tmp, path);
}

// Malformed files are rejected with the path only; JSON.parse messages can echo file content, so they are not surfaced.
export async function loadBudget(path, id) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return freshCounters(id); throw err; }
  let c;
  try { c = JSON.parse(text); } catch { c = null; }
  const isCount = (n) => Number.isInteger(n) && n >= 0;
  const ok = c !== null && typeof c === 'object' && COUNT_KEYS.every((k) => isCount(c[k]))
    && (c.wallStartedAt === null || Number.isFinite(c.wallStartedAt))
    && (c.terminal === null || typeof c.terminal === 'string')
    && typeof c.ownerExtraRoundApproved === 'boolean' && typeof c.notified === 'boolean';
  if (!ok) throw new Error(`Malformed budget state: ${path}`);
  return c;
}
