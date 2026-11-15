/**
 * RT-S13e review-stage primitives. Pure: no filesystem, network or shell access.
 */

const END_STATES = ['accepted', 'needs-owner', 'parked'];
const MAX_REWORKS = 2;
const SHA = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i;
const nonEmpty = value => typeof value === 'string' && value.length > 0;

/** `doneWhen`: a non-empty array of non-empty criteria strings. */
export function validateDoneWhen(doneWhen) {
  if (!Array.isArray(doneWhen) || doneWhen.length === 0 || !doneWhen.every(nonEmpty)) {
    throw new TypeError('doneWhen must be a non-empty array of non-empty strings');
  }
}

/** Worker report `evidence`: exactly one `{ criterion, evidence }` entry per doneWhen index. */
export function validateEvidence(doneWhen, report) {
  validateDoneWhen(doneWhen);
  if (!Array.isArray(report?.evidence)) throw new TypeError('evidence must be an array');
  const seen = new Set();
  for (const entry of report.evidence) {
    const { criterion, evidence } = entry ?? {};
    if (!Number.isInteger(criterion) || criterion < 0 || criterion >= doneWhen.length) {
      throw new TypeError(`evidence criterion ${criterion} is out of range`);
    }
    if (seen.has(criterion)) throw new TypeError(`duplicate evidence for criterion ${criterion}`);
    if (!nonEmpty(evidence)) throw new TypeError(`criterion ${criterion} needs non-empty evidence`);
    seen.add(criterion);
  }
  doneWhen.forEach((_, index) => {
    if (!seen.has(index)) throw new TypeError(`missing evidence for criterion ${index}`);
  });
}

/** Review outcome: pass → accepted; reject → rework (max 2), then needs-owner. Terminal states do not move. */
export function reviewOutcome(task, outcome) {
  if (END_STATES.includes(task.state)) throw new TypeError(`task is terminal in ${task.state}`);
  if (outcome === 'pass') return { ...task, state: 'accepted' };
  if (outcome !== 'reject') throw new TypeError('outcome must be pass or reject');
  const reworks = task.reworks ?? 0;
  if (reworks >= MAX_REWORKS) return { ...task, state: 'needs-owner' };
  return { ...task, state: 'rework', reworks: reworks + 1 };
}

/** Explicit park action. */
export function park(task) {
  return { ...task, state: 'parked' };
}

/** Reviewer input: exactly the diff and doneWhen. Transcript and worker messages never pass through. */
export function buildReviewerInput({ diff, doneWhen }) {
  if (typeof diff !== 'string') throw new TypeError('diff must be a string');
  validateDoneWhen(doneWhen);
  return { diff, doneWhen };
}

/** git argv for an isolated, detached snapshot of `head`; no shell string. */
export function reviewSnapshotArgs({ head, dir }) {
  if (!SHA.test(head)) throw new TypeError('head must be a commit SHA');
  if (!dir.startsWith('/') || dir.split('/').includes('..')) throw new TypeError('dir must be absolute and contain no ..');
  return ['worktree', 'add', '--detach', dir, head];
}

/** The reviewer path runs only when the task record sets optionalReviewer to true. */
export function usesReviewer(task) {
  return task.optionalReviewer === true;
}
