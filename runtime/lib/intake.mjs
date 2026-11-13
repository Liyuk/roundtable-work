const excluded = new Set(['rt:owner', 'rt:deferred', 'rt:running', 'rt:ask', 'rt:blocked', 'rt:hold', 'rt:ready-to-merge']);
const labelsOf = issue => (issue.labels ?? []).map(label => typeof label === 'string' ? label : label.name);
const hasChildIds = ids => Array.isArray(ids) && ids.length > 0 && ids.every(id => Number.isSafeInteger(Number(id)) && Number(id) > 0);

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
export function selectIssues({ issues, owner, dependencyStates = {}, includeRunning = false, recordedChildIssues = {} }) {
  if (!Array.isArray(issues) || typeof owner !== 'string' || !owner) throw new TypeError('Issue snapshot and owner are required');
  const candidates = [], triage = [];
  for (const issue of issues) {
    if (issue.state?.toUpperCase() !== 'OPEN' || issue.author?.login?.toLowerCase() !== owner.toLowerCase()) continue;
    const labels = labelsOf(issue);
    const recovering = includeRunning && labels.includes('rt:running');
    const paused = includeRunning && (labels.includes('rt:ask') || labels.includes('rt:blocked'));
    const heldParent = includeRunning && labels.includes('rt:hold') && hasChildIds(recordedChildIssues[issue.number]);
    if (labels.some(label => excluded.has(label) && !(recovering && label === 'rt:running') && !(paused && ['rt:ask', 'rt:blocked'].includes(label)) && !(heldParent && label === 'rt:hold')) || /^\[owner\]/i.test(issue.title ?? '') || /^\[epic\]/i.test(issue.title ?? '') || /^(?:\[[^\]]+\]\s*)?epic\s*:/i.test(issue.title ?? '') || labels.includes('type:epic')) continue;
    if (!recovering && !paused && labels.includes('rt:proposed') && !labels.includes('rt:approved')) continue;
    if (!labels.length) { triage.push(issue); continue; }
    if (!recovering && !paused && !labels.includes('type:bug') && !labels.includes('type:feature')) continue;
    if (!recovering && !paused && !dependencies(issue.body).every(n => String(dependencyStates[n] ?? '').toUpperCase() === 'CLOSED')) continue;
    const rank = ['priority:p0', 'priority:p1', 'priority:p2'].findIndex(label => labels.includes(label));
    candidates.push({ issue, bug: labels.includes('type:bug') ? 0 : 1, rank: rank < 0 ? 3 : rank, self: labels.includes('rt:self') ? 0 : 1 });
  }
  candidates.sort((a, b) => a.bug - b.bug || a.rank - b.rank || a.self - b.self || String(a.issue.createdAt).localeCompare(String(b.issue.createdAt)) || a.issue.number - b.issue.number);
  return { issues: candidates.map(({ issue }) => ({ id: String(issue.number), priority: 0, state: 'queued', title: issue.title, series: /^\[([^\]]+)\]/.exec(issue.title ?? '')?.[1] ?? null, number: issue.number, url: issue.url, ...(includeRunning ? { labels: issue.labels, body: issue.body, author: issue.author } : {}) })), triage };
}

/** A fresh tracker snapshot is read for each queue pass. Triage is available on the provider. */
export function createIntakeProvider(reader, { includeRunning = false, getDurableState } = {}) {
  const provider = async ({ signal } = {}) => {
    const [owner, issues] = await Promise.all([reader.getOwner({ signal }), reader.listIssues({ signal })]);
    const ids = new Set(issues.flatMap(issue => dependencies(issue.body)));
    const states = {};
    await Promise.all([...ids].map(async n => {
      try { states[n] = (await reader.getIssue(n, { signal }))?.state; }
      catch (error) { if (signal?.aborted) throw error; }
    }));
    const recordedChildIssues = {};
    if (includeRunning && typeof getDurableState === 'function') {
      const heldCandidates = issues.filter(issue => {
        const labels = labelsOf(issue);
        return issue.state?.toUpperCase() === 'OPEN' && issue.author?.login?.toLowerCase() === owner.toLowerCase() &&
          labels.includes('rt:hold') && labels.every(label => !excluded.has(label) || ['rt:hold', 'rt:running'].includes(label)) &&
          (labels.includes('type:bug') || labels.includes('type:feature')) &&
          !/^\[owner\]/i.test(issue.title ?? '') && !/^\[epic\]/i.test(issue.title ?? '') &&
          !/^(?:\[[^\]]+\]\s*)?epic\s*:/i.test(issue.title ?? '') && !labels.includes('type:epic');
      });
      await Promise.all(heldCandidates.map(async issue => {
        try {
          const durable = await getDurableState(String(issue.number));
          if (hasChildIds(durable?.childIssues)) recordedChildIssues[issue.number] = durable.childIssues;
        } catch (error) { if (signal?.aborted) throw error; }
      }));
    }
    const result = selectIssues({ issues, owner, dependencyStates: states, includeRunning, recordedChildIssues });
    provider.triage = result.triage;
    return result.issues;
  };
  provider.triage = [];
  return provider;
}
