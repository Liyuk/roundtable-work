// Self-review filer (RT-S8b, docs/self-supervision.md "(c) Filer"). Turns self-review candidates from proposals() into
// issues under the daily and open caps, deduped by fingerprint. The body comes from an injected completer, with a
// deterministic evidence body when its output is invalid. Promotion of held issues is a once timer per issue.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { proposals } from './self-review.mjs';
import { openTimers } from './event-timers.mjs';
import { openInterventions } from './interventions.mjs';
import { admission } from './intake.mjs';
import { overlappingIssues } from './overlap.mjs';
import { scanHygiene } from './hygiene.mjs';
import { safetyFiles } from './safety.mjs';
import { intakeRequestIssue } from './intake-backlog.mjs';

export const SELF_REVIEW_TIMER = 'self-review:daily';
const LOG = '.roundtable/state/self-review.jsonl';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const LOW_LINES = 200;
const marker = (fp) => `<!-- rt:fingerprint ${fp} -->`;
const names = (labels = []) => labels.map((label) => (typeof label === 'string' ? label : label.name));
const job = (name, payload = {}) => ({ kind: 'heartbeat', issue: null, payload: { job: name, ...payload } });

/** Registers the recurring daily timer once; a second call leaves the first registration (and its schedule) in place. */
export function ensureSelfReviewTimer(timers, goals, now) {
  if (timers.list().some((t) => t.id === SELF_REVIEW_TIMER)) return;
  timers.recurring({ id: SELF_REVIEW_TIMER, at: new Date(now).toISOString(), cadenceMs: goals.selfReview.cadenceHours * HOUR, event: job('self-review') });
}

/** Routes an inbox event of a self-review job: the daily review, or the promotion of one held issue. */
export function runSelfJob({ root, now, event, goals, inputs, client, completer, hygiene }) {
  if (event.payload.job === 'self-promote') return promoteHold({ client, number: event.payload.number });
  return fileSelfReview({ root, now, goals, inputs, client, completer, hygiene });
}

/** Inputs read from the workspace; metrics, failures and cases are not yet recorded by the runtime and stay empty. */
export function gatherInputs(root) {
  const file = join(root, 'docs/host-patch-inventory.md');
  return {
    metrics: { mtbiHours: [], firstPassRate: [], ownerPullInsPerWeek: [] },
    failures: [],
    cases: [],
    interventions: openInterventions(root).entries().entries,
    inventory: existsSync(file) ? readFileSync(file, 'utf8') : '',
  };
}

// The completer's JSON must carry every field of the template; anything else falls back to the evidence body.
function specOf(text) {
  let spec;
  try { spec = JSON.parse(text); } catch { return null; }
  const valid = typeof spec?.goal === 'string' && Array.isArray(spec.acceptance) && typeof spec.outOfScope === 'string'
    && Array.isArray(spec.touchSet) && Number.isInteger(spec.lines) && Number.isInteger(spec.files);
  return valid ? spec : null;
}

function evidenceSpec(candidate) {
  return {
    goal: `Address the self-review finding: ${candidate.title}.`,
    acceptance: [{ run: 'npm test && npm run check', expected: `exit 0; ${candidate.acceptanceHint}` }],
    outOfScope: 'Anything beyond the evidence listed below.',
    touchSet: [], lines: 400, files: 1,
  };
}

function draftOf(candidate, spec) {
  const body = intakeRequestIssue({ title: candidate.title, goal: spec.goal, acceptance: spec.acceptance, outOfScope: spec.outOfScope, files: spec.files, lines: spec.lines }).body;
  const touch = spec.touchSet.length ? ['', '## Touch set', ...spec.touchSet.map((path) => `- ${path}`)] : [];
  return { title: candidate.title, body: [body, ...touch, '', '## Evidence', ...candidate.evidence.map((item) => `- Evidence: ${item}`), '', marker(candidate.fingerprint)].join('\n') };
}

const readLog = (root) => (existsSync(join(root, LOG)) ? readFileSync(join(root, LOG), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
function appendLog(root, record) {
  mkdirSync(dirname(join(root, LOG)), { recursive: true });
  appendFileSync(join(root, LOG), `${JSON.stringify(record)}\n`);
}

const findFiled = async (client, fp) => (await client.search(fp)).find((issue) => issue.body?.includes(marker(fp)));

/** Files this run's candidates. Every outcome is appended to the self-review log; the function returns those records. */
export async function fileSelfReview({ root, now, goals, inputs, client, completer, hygiene }) {
  const { maxPerDay, maxOpen } = goals.selfReview;
  const open = (await client.listOpen()).map((issue) => ({ ...issue, labels: names(issue.labels), body: issue.body ?? '' }));
  const closed = (await client.listClosed()).map((issue) => ({ ...issue, labels: names(issue.labels), body: issue.body ?? '' }));
  const recentlyClosed = closed.filter((issue) => Date.parse(issue.closedAt) > now - 30 * DAY);
  const day = new Date(now).toISOString().slice(0, 10);
  let filedToday = readLog(root).filter((r) => r.outcome === 'filed' && r.at.slice(0, 10) === day).length;
  let openSelf = open.filter((issue) => issue.labels.includes('source:self')).length;
  const results = [];
  const record = (candidate, outcome, extra = {}) => {
    const entry = { at: new Date(now).toISOString(), rule: candidate.rule, fingerprint: candidate.fingerprint, outcome, ...extra };
    appendLog(root, entry);
    results.push(entry);
  };

  for (const candidate of proposals({ ...inputs, goals, openIssues: open, closedIssues: closed, now })) {
    const fp = candidate.fingerprint;
    if ([...open, ...recentlyClosed].some((issue) => issue.body.includes(marker(fp)))) { record(candidate, 'skipped', { reason: 'fingerprint' }); continue; }
    if (filedToday >= maxPerDay) { record(candidate, 'deferred', { reason: 'daily-cap' }); continue; }
    if (openSelf >= maxOpen) { record(candidate, 'deferred', { reason: 'open-cap' }); continue; }

    const spec = specOf(await completer?.(candidate)) ?? evidenceSpec(candidate);
    const draft = draftOf(candidate, spec);
    if (overlappingIssues(draft, closed, { now }).length) { record(candidate, 'skipped', { reason: 'overlap' }); continue; }
    if (!admission(draft).admitted) { record(candidate, 'refused', { reason: 'admission' }); continue; }
    if ((await scanHygiene({ entries: [{ value: draft.title }, { value: draft.body }], ...hygiene })).length) { record(candidate, 'refused', { reason: 'hygiene' }); continue; }
    if (await findFiled(client, fp)) { record(candidate, 'skipped', { reason: 'fingerprint' }); continue; }

    await client.createLabel('source:self');
    let number;
    try {
      ({ number } = await client.createIssue(draft.title, draft.body));
    } catch {
      const found = await findFiled(client, fp);
      if (!found) { record(candidate, 'failed', { reason: 'create' }); continue; }
      number = found.number;
    }
    const low = candidate.risk === 'low' && safetyFiles(spec.touchSet).length === 0 && spec.lines <= LOW_LINES;
    const type = ['T1', 'T4'].includes(candidate.rule) ? 'type:bug' : 'type:feature';
    for (const label of ['source:self', type, 'priority:p2', low ? 'rt:go' : 'rt:hold']) await client.addLabel(number, label);
    if (!low) openTimers(root).once({ id: `self-promote:${number}`, at: new Date(now + DAY).toISOString(), event: job('self-promote', { number }) });
    openInterventions(root).append({ category: 'backlog', ref: `#${number}`, reason: candidate.title, internalized: 'no', source: 'self', at: new Date(now).toISOString() }, { key: fp });
    record(candidate, 'filed', { number });
    filedToday++;
    openSelf++;
  }
  return results;
}

/** Adds rt:go to a held issue unless it was closed or carries rt:owner by the time the timer fires. */
export async function promoteHold({ client, number }) {
  const issue = await client.getIssue(number);
  if (issue.state !== 'OPEN' || names(issue.labels).includes('rt:owner')) return 'skipped';
  await client.addLabel(number, 'rt:go');
  await client.removeLabel(number, 'rt:hold');
  return 'promoted';
}
