// Self-judgment for host-loop stalls. Pure: no fs, no network, no clock; time comes only from `snapshot.at`.
// Exports:
//   initialState()                          { idleCycles, fired } before the first cycle
//   observeCycle({ state, snapshot, config }) { state, firings } for one cycle; repeated keys are not returned again
// Detectors: idle-backlog (rt:go work nothing will take), stale-wait (rt:blocked or ready-to-merge without a PR for too long),
// and red-main (main red for more than 2 h). red-main reads snapshot.mainRed / snapshot.mainGreen; pending is neither and keeps the episode.
// redSince is the first red observation of the loop, not the provider's first red run (the history has no timestamps).
import { buildNotifyRecord } from './outbox-notify.mjs';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const RED_MAIN_HOURS = 2;

export function initialState() {
  return { idleCycles: 0, redSince: null, fired: [] };
}

export function observeCycle({ state, snapshot, config = {} }) {
  const { idleCycles: idleThreshold = 6, staleHours = 4 } = config;
  const byNumber = new Map(snapshot.issues.map((issue) => [issue.number, issue]));
  const openGo = snapshot.issues.filter((issue) => issue.state === 'OPEN' && issue.labels.includes('rt:go'));
  const idle = snapshot.awake && openGo.length > 0 && snapshot.claimable === 0 && snapshot.activeWorkers === 0;
  const idleCycles = idle ? state.idleCycles + 1 : 0;
  const redSince = snapshot.mainGreen ? null : state.redSince ?? (snapshot.mainRed ? snapshot.at : null);

  const candidates = [];
  if (idle && idleCycles >= idleThreshold) {
    for (const [root, cls] of idleRoots(openGo, byNumber, snapshot)) candidates.push(firing('idle-backlog', root, cls, snapshot.at));
  }
  for (const issue of snapshot.issues) {
    const stale = issue.state === 'OPEN' && (issue.labels.includes('rt:blocked') || (issue.labels.includes('rt:ready-to-merge') && !issue.hasOpenPr));
    const age = effectiveAge(issue.since, snapshot);
    if (stale && age > staleHours * HOUR_MS) candidates.push(firing('stale-wait', issue.number, issue.labels.includes('rt:blocked') ? 'rt:blocked' : 'rt:ready-to-merge', snapshot.at, `${issue.since}:${Math.floor(age / DAY_MS)}`));
  }

  if (redSince !== null && snapshot.at - redSince > RED_MAIN_HOURS * HOUR_MS) candidates.push(firing('red-main', null, 'main-red', snapshot.at, `${redSince}`));

  const fresh = candidates.filter((candidate) => !state.fired.includes(candidate.key));
  return { state: { idleCycles, redSince, fired: [...state.fired, ...fresh.map((candidate) => candidate.key)] }, firings: fresh };
}

// Walks each open rt:go issue through its deps; returns Map(root issue -> class) for the unmet blockers.
function idleRoots(openGo, byNumber, snapshot) {
  const roots = new Map();
  const visit = (number, stack) => {
    const issue = byNumber.get(number);
    if (!issue) return roots.set(number, 'unknown-dependency');
    if (stack.includes(number)) return roots.set(number, 'cycle');
    if (issue.state === 'CLOSED') return;
    const unmet = issue.deps.filter((dep) => byNumber.get(dep)?.state !== 'CLOSED');
    if (unmet.length === 0) return roots.set(number, leafClass(issue, snapshot));
    for (const dep of unmet) visit(dep, [...stack, number]);
  };
  for (const issue of openGo) visit(issue.number, []);
  return roots;
}

function leafClass(issue, snapshot) {
  if (snapshot.verifiedComplete.includes(issue.number)) return snapshot.mainRed ? 'main-red' : 'verified-complete-leaf';
  if (issue.labels.includes('rt:hold')) return 'hold';
  if (issue.labels.includes('rt:owner') || issue.labels.includes('rt:ask')) return 'blocked-owner';
  if (issue.labels.includes('rt:blocked')) return 'blocked-internal';
  return 'unclaimed';
}

// Wait time since `since` minus the part overlapped by freeze intervals.
function effectiveAge(since, { at, freezes = [] }) {
  const frozen = freezes.reduce((sum, { start, end }) => sum + Math.max(0, Math.min(end, at) - Math.max(start, since)), 0);
  return at - since - frozen;
}

// idle-backlog keys by UTC date; stale-wait passes `<since>:<24h index>` so one wait episode keys once per 24 h of effective wait.
function firing(kind, root, cls, at, suffix = new Date(at).toISOString().slice(0, 10)) {
  const action = cls === 'verified-complete-leaf' ? 'auto-close' : 'escalate';
  const ts = new Date(at).toISOString();
  const label = root ?? 'main';
  const key = `notice:stall:${kind}:${label}:${suffix}`;
  const item = { id: key, kind: 'notification', issue: root, payload: { subtype: 'stall-alert', kind, class: cls, action } };
  return { kind, root, class: cls, action, key, ledger: `${ts}\t${kind}\t${label}\t${cls}\t${action}\t${key}\n`, item, record: buildNotifyRecord(item, ts) };
}
