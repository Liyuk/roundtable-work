import { readFile } from 'node:fs/promises';

/** Pipeline stages in execution order. */
export const STAGES = Object.freeze(['design', 'plan', 'decompose', 'goal', 'execute', 'review', 'e2e', 'accept']);

/**
 * Next stage for `line` ({ stage }) given `facts`:
 * { decomposeTriggered, reviewPassed, e2eConfigured, e2ePassed } (all booleans).
 * Returns { stage, skipped? }; `stage` is null after accept. `skipped` carries the recorded skip reason.
 */
export function nextStage({ stage }, facts) {
  switch (stage) {
    case 'design': return { stage: 'plan' };
    case 'plan': return facts.decomposeTriggered ? { stage: 'decompose' } : { stage: 'goal', skipped: 'decompose:no-trigger' };
    case 'decompose': return { stage: 'goal' };
    case 'goal': return { stage: 'execute' };
    case 'execute': return { stage: 'review' };
    case 'review': return !facts.reviewPassed ? { stage: 'execute' } : facts.e2eConfigured ? { stage: 'e2e' } : { stage: 'accept', skipped: 'e2e:not-configured' };
    case 'e2e': return { stage: facts.e2ePassed ? 'accept' : 'execute' };
    case 'accept': return { stage: null };
  }
}

/** Parse the first ```rt-plan fenced JSON block; returns the plan or null when missing or invalid. */
export function parsePlan(text) {
  const match = /^```rt-plan[ \t]*\n([\s\S]*?)\n```/m.exec(text);
  if (!match) return null;
  let plan;
  try { plan = JSON.parse(match[1]); } catch { return null; }
  const valid = plan && typeof plan === 'object' && typeof plan.approach === 'string' && plan.approach.trim() !== ''
    && Array.isArray(plan.files) && Array.isArray(plan.risks) && Array.isArray(plan.tests);
  return valid ? plan : null;
}

/** Gate before execute: one re-ask for a missing or invalid plan, then proceed degraded. `reasked` is set by the caller after a re-ask. */
export function executeGate(text, { reasked }) {
  const plan = parsePlan(text);
  if (plan) return { action: 'execute', plan };
  return reasked ? { action: 'execute', degraded: true } : { action: 're-ask' };
}

/** Whether `runtime/plan-gate.config.json` enables the technical-plan gate (default off: the file says false). */
export async function planGateEnabled(path = new URL('../plan-gate.config.json', import.meta.url)) {
  return JSON.parse(await readFile(path, 'utf8')).enabled === true;
}

/** Run the repository e2e command on `head` via the injected `exec(command, { timeoutMs, head })` -> { code, timedOut }. */
export async function runE2e({ exec, head, config }) {
  const { command, timeoutMs } = config.e2e ?? {};
  if (!command) return { skipped: 'e2e:not-configured' };
  const result = await exec(command, { timeoutMs, head });
  return { ok: result.code === 0 && !result.timedOut };
}

/** Ledger entry for a stage change; `at` is an ISO string supplied by the caller. */
export function ledgerEntry({ from, to, at, role }) {
  return { stage: to, from, at, role };
}
