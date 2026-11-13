import { resumeDecomposition } from './decisions.mjs';

const excluded = new Set(['rt:owner', 'rt:deferred', 'rt:running', 'rt:ask', 'rt:blocked', 'rt:hold', 'rt:ready-to-merge']);
const labelsOf = issue => (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name);

export function dependencies(body = '') {
  const found = new Set();
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?(?:\*\*|__|\*|_)?(?:depends on|blocked by)(?:\*\*|__|\*|_)?\s+(.+)$/i);
    // A repository-qualified reference (owner/repo#N) names a different
    // tracker namespace. Intake only resolves bare #N references locally.
    if (match) for (const number of match[1].matchAll(/(?<![\w./-])#(\d+)/g)) found.add(Number(number[1]));
  }
  return [...found];
}

/** Select from a tracker snapshot; missing or unknown dependency states are ineligible. */
export function selectIssues({ issues, owner, dependencyStates = {}, includeRunning = false }) {
  if (!Array.isArray(issues) || typeof owner !== 'string' || !owner) throw new TypeError('Issue snapshot and owner are required');
  const candidates = [], triage = [];
  for (const issue of issues) {
    if (issue.state?.toUpperCase() !== 'OPEN' || issue.author?.login?.toLowerCase() !== owner.toLowerCase()) continue;
    const labels = labelsOf(issue);
    if (labels.some(label => excluded.has(label) && !(includeRunning && ['rt:running', 'rt:ask', 'rt:blocked'].includes(label))) || /^\[owner\]/i.test(issue.title ?? '') || /^\[epic\]/i.test(issue.title ?? '') || /^(?:\[[^\]]+\]\s*)?epic\s*:/i.test(issue.title ?? '') || labels.includes('type:epic')) continue;
    const recovering = includeRunning && labels.some(label => ['rt:running', 'rt:ask', 'rt:blocked'].includes(label));
    if (!recovering && labels.includes('rt:proposed') && !labels.includes('rt:approved')) continue;
    if (!labels.length) { triage.push(issue); continue; }
    if (!recovering && !labels.includes('type:bug') && !labels.includes('type:feature')) continue;
    if (!recovering && !dependencies(issue.body).every(n => String(dependencyStates[n] ?? '').toUpperCase() === 'CLOSED')) continue;
    const rank = ['priority:p0', 'priority:p1', 'priority:p2'].findIndex(label => labels.includes(label));
    candidates.push({ issue, bug: labels.includes('type:bug') ? 0 : 1, rank: rank < 0 ? 3 : rank, self: labels.includes('rt:self') ? 0 : 1 });
  }
  candidates.sort((a, b) => a.bug - b.bug || a.rank - b.rank || a.self - b.self || String(a.issue.createdAt).localeCompare(String(b.issue.createdAt)) || a.issue.number - b.issue.number);
  return { issues: candidates.map(({ issue }) => ({ id: String(issue.number), priority: 0, state: 'queued', title: issue.title, series: /^\[([^\]]+)\]/.exec(issue.title ?? '')?.[1] ?? null, number: issue.number, url: issue.url, ...(includeRunning ? { labels: issue.labels, body: issue.body, author: issue.author } : {}) })), triage };
}

/** A fresh tracker snapshot is read for each queue pass. Triage is available on the provider. */
export function createIntakeProvider(reader, { includeRunning = false } = {}) {
  const provider = async ({ signal, store, client } = {}) => {
    const [owner, issues] = await Promise.all([reader.getOwner({ signal }), reader.listIssues({ signal })]);
    const ids = new Set(issues.flatMap(issue => dependencies(issue.body)));
    const states = {};
    await Promise.all([...ids].map(async n => {
      try { states[n] = (await reader.getIssue(n, { signal }))?.state; }
      catch (error) { if (signal?.aborted) throw error; }
    }));
    const released = [];
    const recovering = new Set();
    if (includeRunning && store && client) {
      for (const issue of issues) {
        const number = Number(issue.number);
        if (!Number.isSafeInteger(number) || number < 1) continue;
        let state = await store.load(String(number));
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
        released.push({ ...issue, labels: (issue.labels ?? []).filter(label => (typeof label === 'string' ? label : label.name) !== 'rt:hold') });
      }
    }
    const result = selectIssues({ issues: [...issues.filter(issue => !labelsOf(issue).includes('rt:hold') && !recovering.has(Number(issue.number))), ...released], owner, dependencyStates: states, includeRunning });
    provider.triage = result.triage;
    return result.issues;
  };
  provider.triage = [];
  return provider;
}
