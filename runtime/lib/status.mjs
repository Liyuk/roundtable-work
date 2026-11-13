import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dependencies, selectIssues } from './intake.mjs';
import { normalizeState } from './state.mjs';

export const RUNTIME_DEFAULTS = Object.freeze({ maxWakesPerIssue: 5, maxDeveloperAttempts: 3, maxReviewerUnavailable: 5, heartbeatTimeoutMs: 120000 });

const cleanError = () => 'snapshot source could not be read';
const validTime = (value) => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());
const isoTime = (value) => validTime(value) ? new Date(value).toISOString() : null;

async function readLocalSnapshot(workRoot) {
  const stateRoot = join(workRoot, 'state');
  const names = await readdir(stateRoot);
  const files = new Map();
  for (const name of names) {
    const epochMatch = /^~([0-9a-f]+)\.epoch-(\d+)\.json$/.exec(name);
    let id, epoch;
    if (epochMatch) {
      id = Buffer.from(epochMatch[1], 'hex').toString('utf8');
      epoch = Number(epochMatch[2]);
      if (Buffer.from(id).toString('hex') !== epochMatch[1] || !Number.isSafeInteger(epoch)) continue;
    } else if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.json$/.test(name)) {
      id = name.slice(0, -5);
      epoch = -1;
    } else continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) continue;
    if (!files.has(id) || epoch > files.get(id).epoch) files.set(id, { name, epoch });
  }
  const issues = [];
  let complete = true;
  for (const [id, { name }] of files) {
    try {
      const raw = JSON.parse(await readFile(join(stateRoot, name), 'utf8'));
      const state = normalizeState(id, raw);
      if (state.lastEvent != null && (typeof state.lastEvent !== 'object' || Array.isArray(state.lastEvent))) { state.lastEvent = null; complete = false; }
      if (state.lastEvent?.type != null && typeof state.lastEvent.type !== 'string') { state.lastEvent.type = null; complete = false; }
      for (const [object, key] of [[state, 'heartbeatAt'], [state.lastEvent, 'at']]) {
        if (object?.[key] != null && !validTime(object[key])) { object[key] = null; complete = false; }
      }
      issues.push(state);
    } catch { complete = false; }
  }
  return { issues, complete };
}

const shortText = (value) => typeof value === 'string' && !/[\r\n]/.test(value) && value.length <= 160 ? value : null;
const verdict = (state, gate) => {
  const passed = Array.isArray(state?.gateRecord?.passed) && state.gateRecord.passed.includes(gate);
  if (passed) return { result: 'passed', scope: null, blockReason: null };
  const heldGate = state?.status === 'waiting_external' && state?.lastEvent?.type === 'finalize_hold'
    && typeof state.lastEvent.detail === 'string' ? /^(gate[012]): /.exec(state.lastEvent.detail)?.[1] : null;
  return heldGate === gate ? { result: 'waiting', scope: null, blockReason: null } : null;
};
const budget = (used, limit) => ({
  used: Number.isSafeInteger(used) && used >= 0 ? used : null,
  remaining: Number.isSafeInteger(used) && used >= 0 && Number.isSafeInteger(limit) && limit >= 0 ? Math.max(0, limit - used) : null,
});

/** Collect a best-effort, read-only status snapshot. Sources may be injected for synthetic tests. */
export async function collectStatus({ workRoot = '.', sources = {}, now = Date.now, budgets = {}, heartbeatTimeoutMs = RUNTIME_DEFAULTS.heartbeatTimeoutMs } = {}) {
  const generatedAt = new Date(now()).toISOString();
  let remote = { refreshed: false, status: 'not refreshed', error: null };
  let remoteData = null;
  try {
    remoteData = await (sources.github?.() ?? Promise.resolve({ issues: [], queue: [] }));
    remote = { refreshed: true, status: 'refreshed', error: null };
  } catch {
    remote = { refreshed: false, status: 'not refreshed', error: cleanError() };
  }
  let localData = null;
  let local = { available: false, status: 'no local snapshot', error: null };
  try {
    localData = await (sources.local?.() ?? readLocalSnapshot(workRoot));
    local = { available: true, complete: localData.complete !== false, status: localData.complete === false ? 'incomplete' : 'available', error: localData.complete === false ? cleanError() : null };
  } catch {
    local = { available: false, status: 'no local snapshot', error: cleanError() };
  }
  const localIssues = new Map((localData?.issues ?? []).map((state) => [String(state.id), state]));
  const remoteIssues = remoteData?.issues ?? [];
  const ids = new Set([...remoteIssues.map((issue) => String(issue.number ?? issue.id)), ...localIssues.keys()]);
  const issues = [...ids].filter((id) => id !== 'undefined').map((id) => {
    const remoteIssue = remoteIssues.find((issue) => String(issue.number ?? issue.id) === id);
    const state = localIssues.get(id);
    const labels = (remoteIssue?.labels ?? []).map((label) => typeof label === 'string' ? label : label.name).filter(Boolean);
    const event = state?.lastEvent;
    return {
      id,
      title: remoteIssue?.title ?? null,
      metadata: { labels, state: remoteIssue?.state ?? null, updatedAt: remoteIssue?.updatedAt ?? null },
      stage: state?.phase ?? state?.checkpoint?.phase ?? null,
      pr: remoteData?.linkedPRs == null ? null : (remoteData.linkedPRs[id] ?? []),
      updatedAt: isoTime(event?.at) ?? (remoteIssue?.updatedAt ?? null),
      status: state?.status ?? null,
      heartbeat: isoTime(state?.heartbeatAt),
      heartbeatLive: validTime(state?.heartbeatAt) && Number.isFinite(heartbeatTimeoutMs) ? now() - state.heartbeatAt <= heartbeatTimeoutMs : null,
      gates: {
        gate: verdict(state, 'gate0'),
        review: verdict(state, 'gate1'),
        xCheck: verdict(state, 'gate2'),
      },
      waiting: event?.type?.startsWith('waiting') || state?.status?.startsWith('waiting')
        ? { type: shortText(event?.type) ?? state.status, conclusion: shortText(state?.pause?.category), waitingOn: state?.pause?.kind === 'ask' ? 'owner' : null, since: isoTime(event?.at) }
        : null,
      attempts: state?.attempts ?? null,
      budgets: {
        wakes: budget(state?.attempts?.wakes, budgets.maxWakesPerIssue),
        developerRetries: budget(state?.attempts?.developer, budgets.maxDeveloperAttempts),
        reviewerUnavailable: budget(state?.attempts?.reviewerUnavailable, budgets.maxReviewerUnavailable),
      },
    };
  });
  const activeIssues = issues.filter((issue) => issue.status === 'working' || (issue.metadata.labels.includes('rt:running') && !['waiting_person', 'waiting_external', 'blocked', 'out-of-scope'].includes(issue.status) && !issue.metadata.labels.some(label => ['rt:ask', 'rt:blocked'].includes(label))));
  const activeIssue = activeIssues[0] ?? null;
  const blockers = issues.filter((issue) => ['blocked', 'waiting_person', 'interrupted', 'out-of-scope'].includes(issue.status) || issue.metadata.labels.some((label) => ['rt:blocked', 'rt:ask'].includes(label))).map(({ id, status, waiting, metadata }) => ({ id, status: status ?? (metadata.labels.includes('rt:blocked') ? 'blocked' : 'waiting_person'), waiting }));
  const quotaWait = remoteData?.quotaWait ?? null;
  const queue = Array.isArray(remoteData?.queue) ? remoteData.queue.map(String) : null;
  const heartbeatTimes = issues.map((issue) => issue.heartbeat).filter(Boolean);
  return {
    generatedAt,
    remote,
    local,
    queue: { count: queue?.length ?? null, issueIds: queue },
    active: { issue: activeIssue?.id ?? null, issueIds: activeIssues.map(issue => issue.id), idle: activeIssue ? false : (remote.refreshed && local.available && local.complete ? true : null) },
    blockers,
    blockerCount: remote.refreshed && local.available && local.complete ? blockers.length : null,
    quotaWait,
    issues,
    heartbeat: { latest: heartbeatTimes.sort().at(-1) ?? null },
    waiting: issues.filter((issue) => issue.waiting).map(({ id, waiting }) => ({ id, ...waiting })),
    recentMerges: remoteData?.recentMerges ?? localData?.recentMerges ?? null,
    budgets: {
      wakes: budgets.maxWakesPerIssue ?? null,
      developerRetries: budgets.maxDeveloperAttempts ?? null,
      reviewerUnavailable: budgets.maxReviewerUnavailable ?? null,
    },
  };
}

/** Render every top-level snapshot field in a stable, English-only text view. */
export function formatStatus(snapshot) {
  return Object.entries(snapshot).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n');
}

export async function runStatus({ argv = [], cwd = process.cwd(), sources, now } = {}) {
  const { parseArgs } = await import('node:util');
  const { values } = parseArgs({ args: argv, options: {
    json: { type: 'boolean' }, 'work-root': { type: 'string' }, queue: { type: 'string' }, repo: { type: 'string' }, providers: { type: 'string' },
  } });
  let selectedSources = sources;
  if (!selectedSources && values.providers) {
    const { pathToFileURL } = await import('node:url');
    const { resolve } = await import('node:path');
    selectedSources = (await import(pathToFileURL(resolve(values.providers)).href)).default;
  }
  if (!selectedSources) {
    const { createGitHubReader } = await import('../../scripts/github-read.mjs');
    const reader = createGitHubReader({ repo: values.repo });
    selectedSources = {
      async github() {
        const [repository, issues] = await Promise.all([reader.getRepository(), reader.listIssues()]);
        const owner = repository.owner;
        const [recentMerges, linkedPRs] = await Promise.all([
          reader.listRecentMerges().catch(() => null),
          reader.listLinkedPullRequests(repository).catch(() => null),
        ]);
        const dependencyIds = new Set(issues.flatMap((issue) => dependencies(issue.body)));
        const dependencyStates = {};
        let complete = true;
        await Promise.all([...dependencyIds].map(async (number) => {
          try { dependencyStates[number] = (await reader.getIssue(number))?.state; if (!['OPEN', 'CLOSED'].includes(String(dependencyStates[number]).toUpperCase())) complete = false; } catch { complete = false; }
        }));
        const queue = selectIssues({ issues, owner, dependencyStates }).issues;
        return { issues, recentMerges, linkedPRs, queue: complete ? queue.map((issue) => issue.id) : null };
      },
    };
  }
  const snapshot = await collectStatus({ workRoot: values['work-root'] ?? cwd, sources: selectedSources, now, budgets: RUNTIME_DEFAULTS, heartbeatTimeoutMs: RUNTIME_DEFAULTS.heartbeatTimeoutMs });
  return { snapshot, output: values.json ? JSON.stringify(snapshot, null, 2) : formatStatus(snapshot) };
}
