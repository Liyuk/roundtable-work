import { resumeDecomposition } from './decisions.mjs';
import { CorruptStateError } from './state.mjs';
import { duplicatesOf, overlappingIssues } from './overlap.mjs';
import { seriesKey } from './series-key.mjs';

const excluded = new Set(['rt:owner', 'rt:deferred', 'rt:running', 'rt:ask', 'rt:blocked', 'rt:hold', 'rt:ready-to-merge']);
const labelsOf = issue => (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name);

const section = (body, name) => {
  const match = new RegExp(`^#{1,6}\\s+(?:${name})\\s*\\r?\\n([\\s\\S]*?)(?=^#{1,6}\\s+|(?![\\s\\S]))`, 'im').exec(body);
  return match?.[1]?.trim() ?? '';
};

function parseAdmission(body, source, overlap = [], duplicates = []) {
  const goal = section(body, 'Goal');
  const acceptance = section(body, 'Observable acceptance|Acceptance criteria|Acceptance');
  const scope = section(body, 'Out of scope|Non-goals');
  const deps = section(body, 'Dependencies');
  const size = section(body, 'Size estimate|Estimated size');
  const lines = /^[ \t]*(?:changed\s+)?lines[ \t]*:[ \t]*(\d+)[ \t]*$/im.exec(size);
  const files = /^[ \t]*files[ \t]*:[ \t]*(\d+)[ \t]*$/im.exec(size);
  const command = /(?:run|command|check)\s*:\s*`([^`]+)`/i.exec(acceptance);
  const expected = /(?:expected(?:\s+result)?|result)\s*:\s*([^\n]+)/i.exec(acceptance);
  const missing = [];
  if (!goal) missing.push('goal');
  if (!command || !command[1].trim()) missing.push('acceptance_command');
  if (!expected?.[1]?.trim()) missing.push('acceptance_expected_result');
  if (!scope) missing.push('out_of_scope');
  if (!deps) missing.push('dependencies');
  if (!lines) missing.push('size_lines');
  if (!files) missing.push('size_files');
  const tooLarge = Boolean(lines && Number(lines[1]) > 400) || Boolean(files && Number(files[1]) > 5);
  const parseableSize = Boolean(lines && files);
  const reasons = [];
  if (missing.length) reasons.push(...missing.map(field => ({ code: 'missing_field', field })));
  if (parseableSize && tooLarge) reasons.push({ code: 'size_exceeded', lines: Number(lines[1]), files: Number(files[1]), decision: 'decompose' });
  if (!parseableSize) reasons.push({ code: 'size_unparseable', decision: 'decompose' });
  const cited = [...body.matchAll(/Builds on #(\d+)/gi)].map(match => Number(match[1]));
  const overlapRefused = overlap.length > 0 && !(overlap.some(number => cited.includes(number)) && section(body, 'Delta'));
  if (overlapRefused) reasons.push({ code: 'scope_overlap', issues: overlap, decision: 'reask' });
  if (duplicates.length) reasons.push({ code: 'duplicate', issues: duplicates, decision: 'skip' });
  const needsHuman = /(?:needs human decision|human input required)\s*:\s*(?:yes|true)/i.test(body);
  const sizeRefused = !parseableSize || tooLarge;
  return {
    admitted: missing.length === 0 && parseableSize && !tooLarge && !overlapRefused && !duplicates.length,
    reasons,
    missing,
    needsHuman,
    ...(duplicates.length ? { decision: 'skip' } : sizeRefused ? { decision: 'decompose' } : overlapRefused ? { decision: 'reask' } : needsHuman && missing.length ? { decision: 'ask' } : {}),
    source,
  };
}

/** Evaluate the ticket body, or a complete marked Chief draft, without side effects. */
function chiefDraft(issue) {
  const draft = (issue.comments ?? []).map(comment => String(comment.body ?? comment))
    .find(body => body.includes('<!-- rt:admission-draft -->'));
  return draft?.slice(draft.indexOf('<!-- rt:admission-draft -->') + '<!-- rt:admission-draft -->'.length).trim() ?? '';
}

/** Scope overlap with closed issues is checked against the same text the admission parses; a duplicate of open work is skipped. */
export function admission(issue, scope = {}) {
  const draft = chiefDraft(issue);
  const body = draft || String(issue.body ?? '');
  const text = { number: issue.number, title: issue.title, body };
  const overlap = overlappingIssues(text, scope.closed, scope);
  return parseAdmission(body, draft ? 'chief_draft' : 'body', overlap, duplicatesOf(text, scope));
}

const admissionText = issue => `${issue.body ?? ''}\n${chiefDraft(issue)}`;

export function dependencies(body = '') {
  const found = new Set();
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?(?:\*\*|__|\*|_)?(?:depends on:?|blocked by:?)(?:\*\*|__|\*|_)?\s+(.+)$/i);
    // A repository-qualified reference (owner/repo#N) names a different
    // tracker namespace. Intake only resolves bare #N references locally.
    if (match) for (const number of match[1].matchAll(/(?<![\w./-])#(\d+)/g)) found.add(Number(number[1]));
  }
  return [...found];
}

/** Select from a tracker snapshot; missing or unknown dependency states are ineligible. */
export function selectIssues({ issues, owner, dependencyStates = {}, includeRunning = false, closed, open, linked, now, days, threshold }) {
  if (!Array.isArray(issues) || typeof owner !== 'string' || !owner) throw new TypeError('Issue snapshot and owner are required');
  const candidates = [], triage = [], admissionResults = [];
  for (const issue of issues) {
    if (issue.state?.toUpperCase() !== 'OPEN' || issue.author?.login?.toLowerCase() !== owner.toLowerCase()) continue;
    const labels = labelsOf(issue);
    const paused = includeRunning && labels.some(label => ['rt:ask', 'rt:blocked'].includes(label));
    if (labels.some(label => excluded.has(label) && !(includeRunning && ['rt:running', 'rt:ask', 'rt:blocked'].includes(label)) && !(paused && label === 'rt:ready-to-merge')) || /^\[owner\]/i.test(issue.title ?? '') || /^\[epic\]/i.test(issue.title ?? '') || /^(?:\[[^\]]+\]\s*)?epic\s*:/i.test(issue.title ?? '') || labels.includes('type:epic')) continue;
    const recovering = includeRunning && labels.some(label => ['rt:running', 'rt:ask', 'rt:blocked'].includes(label));
    if (!recovering && labels.includes('rt:proposed') && !labels.includes('rt:approved')) continue;
    if (!labels.length) { triage.push(issue); continue; }
    const loopCreated = labels.includes('rt:self') || labels.includes('rt:followup');
    if (!recovering && (loopCreated ? !labels.includes('rt:go') : !labels.includes('type:bug') && !labels.includes('type:feature'))) continue;
    if (!recovering && !dependencies(admissionText(issue)).every(n => String(dependencyStates[n] ?? '').toUpperCase() === 'CLOSED')) continue;
    if (!recovering) {
      const result = admission(issue, { closed, open, linked, now, days, threshold });
      if (!result.admitted) {
        admissionResults.push({ id: String(issue.number), admitted: false, reasons: result.reasons, missing: result.missing, needsHuman: result.needsHuman, ...(result.decision ? { decision: result.decision } : {}) });
        continue;
      }
    }
    const rank = ['priority:p0', 'priority:p1', 'priority:p2'].findIndex(label => labels.includes(label));
    candidates.push({ issue, bug: labels.includes('type:bug') ? 0 : 1, rank: rank < 0 ? 3 : rank, self: loopCreated ? 0 : 1 });
  }
  candidates.sort((a, b) => a.bug - b.bug || a.rank - b.rank || a.self - b.self || String(a.issue.createdAt).localeCompare(String(b.issue.createdAt)) || a.issue.number - b.issue.number);
  return { issues: candidates.map(({ issue }) => ({ id: String(issue.number), priority: 0, state: 'queued', title: issue.title, series: seriesKey(issue.title), number: issue.number, url: issue.url, ...(includeRunning ? { labels: issue.labels, body: issue.body, author: issue.author } : {}) })), triage, admission: admissionResults };
}

// Linked pull requests are a best-effort dedupe signal, as in status: a failed read leaves intake running without them.
export const linkedPullRequests = (reader, signal) => reader.getRepository({ signal })
  .then(repository => reader.listLinkedPullRequests(repository, { signal }))
  .catch(error => { if (signal?.aborted) throw error; return {}; });

/** A fresh tracker snapshot is read for each queue pass. Triage is available on the provider. */
export function createIntakeProvider(reader, { includeRunning = false } = {}) {
  const provider = async ({ signal, store, client } = {}) => {
    const [owner, issues, closed, linked] = await Promise.all([reader.getOwner({ signal }), reader.listIssues({ signal }), typeof reader.listClosedIssues === 'function' ? reader.listClosedIssues({ signal }) : [], typeof reader.listLinkedPullRequests === 'function' ? linkedPullRequests(reader, signal) : {}]);
    const scope = { closed, open: issues, linked };
    const candidates = issues.filter(issue => !includeRunning || !labelsOf(issue).some(label => ['rt:running', 'rt:ask', 'rt:blocked'].includes(label)))
      .filter(issue => !admission(issue, scope).admitted);
    const hydrated = await Promise.all(issues.map(async issue => {
      if (!candidates.includes(issue) || typeof reader.listComments !== 'function') return issue;
      try { return { ...issue, comments: await reader.listComments(issue.number, { signal }) }; }
      catch (error) { if (signal?.aborted) throw error; return issue; }
    }));
    const ids = new Set(hydrated.flatMap(issue => dependencies(admissionText(issue))));
    const states = {};
    await Promise.all([...ids].map(async n => {
      try { states[n] = (await reader.getIssue(n, { signal }))?.state; }
      catch (error) { if (signal?.aborted) throw error; }
    }));
    const released = new Map();
    const recovering = new Set();
    if (includeRunning && store && client) {
      // A closed issue cannot be resumed: drop its pause labels before marking it done, so a failed label
      // write is retried next pass and the local row never claims a person is still being waited on.
      for (const id of await store.ids()) {
        const number = Number(id);
        if (!Number.isSafeInteger(number) || number < 1) continue;
        let local;
        try { local = await store.load(id); }
        catch (error) { if (signal?.aborted || !(error instanceof CorruptStateError)) throw error; continue; }
        if (!local.pause && !['waiting_person', 'out-of-scope'].includes(local.status)) continue;
        let remote;
        try { remote = await reader.getIssue(number, { signal }); }
        catch (error) { if (signal?.aborted) throw error; continue; }
        if (remote?.state?.toUpperCase() !== 'CLOSED') continue;
        for (const label of ['rt:ask', 'rt:blocked']) if (labelsOf(remote).includes(label)) await client.removeLabel(number, label);
        await store.update(id, s => {
          s.status = 'done'; s.phase = null; s.checkpoint = null; s.pause = undefined;
          s.lastEvent = { type: 'terminal_closed', at: Date.now(), detail: 'CLOSED' };
        });
      }
      for (const issue of issues) {
        const number = Number(issue.number);
        if (!Number.isSafeInteger(number) || number < 1) continue;
        let state;
        try { state = await store.load(String(number)); }
        catch (error) { if (signal?.aborted || !(error instanceof CorruptStateError)) throw error; continue; }
        if (state.decomposition?.status === 'creating') {
          recovering.add(number);
          await resumeDecomposition({ number, store, client });
          state = await store.load(String(number));
          if (state.decomposition?.status !== 'waiting') continue;
        } else if (!labelsOf(issue).includes('rt:hold')) continue;
        const childIds = state.decomposition?.status === 'waiting' ? state.decomposition.childIds : null;
        if (!Array.isArray(childIds) || childIds.length === 0 || childIds.length > 20
          || childIds.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(childIds).size !== childIds.length) continue;
        const children = await Promise.all(childIds.map(async id => {
          try { return await reader.getIssue(id, { signal }); } catch (error) { if (signal?.aborted) throw error; return null; }
        }));
        if (children.some(child => child?.state?.toUpperCase() !== 'CLOSED')) continue;
        await store.update(String(number), current => {
          if (current.decomposition?.status !== 'waiting' || JSON.stringify(current.decomposition.childIds) !== JSON.stringify(childIds)) return;
          current.status = 'queued'; current.phase = null; current.checkpoint = null;
          current.lastEvent = { type: 'decomposition_ready', at: Date.now(), detail: childIds };
        });
        await client.removeLabel(number, 'rt:hold');
        await store.update(String(number), current => {
          if (current.decomposition?.status === 'waiting' && JSON.stringify(current.decomposition.childIds) === JSON.stringify(childIds)) {
            current.decomposition.status = 'released';
            current.lastEvent = { type: 'decomposition_released', at: Date.now(), detail: childIds };
          }
        });
        released.set(number, { ...issue, labels: (issue.labels ?? []).filter(label => (typeof label === 'string' ? label : label.name) !== 'rt:hold') });
      }
    }
    const result = selectIssues({ issues: [...hydrated.filter(issue => !recovering.has(Number(issue.number)) && !released.has(Number(issue.number))), ...released.values()], owner, dependencyStates: states, includeRunning, ...scope });
    provider.triage = result.triage;
    provider.admission = result.admission;
    return result.issues;
  };
  provider.triage = [];
  provider.admission = [];
  return provider;
}
