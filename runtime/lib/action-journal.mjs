// Action journal: an append-only record of every deferred action (`.roundtable/state/actions.jsonl`), its state
// changes, and the revert recipe that undoes it. Each record is fsynced before the side effect it describes.
import { copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const ACTIONS_PATH = '.roundtable/state/actions.jsonl';
export const SNAPSHOTS_DIR = '.roundtable/state/action-snapshots';
const DAY = 24 * 60 * 60 * 1000;

const sha256 = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

// Builds the ordered revert steps for an action from what was recorded before it ran. `false` means no recipe.
export function buildRevert(action, before) {
  const { issue } = action;
  const steps = [];
  if (action.kind === 'merge') steps.push({ step: 'git-revert-merge', mergeCommit: null });
  if (before.labels) steps.push({ step: 'labels-restore', issue, labels: before.labels });
  if (before.file) steps.push({ step: 'file-restore', path: before.file.path, sha256: before.file.sha256 });
  if (before.issueState === 'open') steps.push({ step: 'issue-reopen', issue });
  if (before.issueState === 'closed') steps.push({ step: 'issue-close', issue });
  return steps.length > 0 ? steps : false;
}

export function openActionJournal(root, { git, github, now = Date.now } = {}) {
  const file = join(root, ACTIONS_PATH);
  const actions = new Map(); // id -> action record
  const states = new Map(); // id -> current state
  const executed = new Map(); // id -> facts recorded with executed_pending_confirmation
  const done = new Set(); // revert step keys that completed

  const index = (rec) => {
    if (rec.type === 'action') return actions.set(rec.id, rec);
    states.set(rec.id, rec.state);
    if (rec.state === 'executed_pending_confirmation') executed.set(rec.id, rec.facts ?? {});
    if (rec.facts?.ok) done.add(rec.facts.key);
  };
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) index(JSON.parse(line));
  }

  const write = (rec) => {
    mkdirSync(dirname(file), { recursive: true });
    const fd = openSync(file, 'a');
    writeSync(fd, JSON.stringify(rec) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    index(rec);
  };
  const state = (id, value, facts = {}) => write({ type: 'state', id, state: value, facts, at: now() });
  const notice = (id, subtype, value) => ({ id: `notice:action:${id}:${value}`, subtype, actionId: id, state: value });

  // Workspace-relative paths only: a recorded path must not escape the workspace.
  const inside = (rel) => {
    const abs = resolve(root, rel);
    if (!abs.startsWith(resolve(root) + sep)) throw new TypeError(`path escapes the workspace: ${rel}`);
    return abs;
  };
  const snapshotFile = (id, rel) => join(root, SNAPSHOTS_DIR, id, basename(rel));

  async function perform({ action, tier, apply, notify }) {
    const id = `act:${action.kind}:${action.issue}:${action.key}`;
    if (states.has(id)) return { id, state: states.get(id) };
    let before = action.before;
    if (before.file) {
      const abs = inside(before.file);
      const snap = snapshotFile(id, before.file);
      mkdirSync(dirname(snap), { recursive: true });
      copyFileSync(abs, snap);
      before = { ...before, file: { path: before.file, sha256: await sha256(snap) } };
    }
    const revert = buildRevert({ kind: action.kind, issue: action.issue }, before);
    write({ type: 'action', id, kind: action.kind, issue: action.issue, tier, reasons: action.reasons, plan: action.plan, before, revert, at: now() });

    if (tier === 'approve-first') {
      state(id, 'awaiting_approval');
      notify(notice(id, 'approval-request', 'awaiting_approval'));
      return { id, state: 'awaiting_approval' };
    }
    state(id, 'executing');
    const facts = { ...(await apply()) };
    if (before.file) facts.postSha256 = await sha256(inside(before.file.path));
    if (tier === 'auto-silent') {
      state(id, 'settled');
      return { id, state: 'settled' };
    }
    state(id, 'executed_pending_confirmation', facts);
    notify(notice(id, 'action-pending-confirmation', 'executed_pending_confirmation'));
    return { id, state: 'executed_pending_confirmation' };
  }

  async function runStep(id, step, facts) {
    if (step.step === 'git-revert-merge') {
      const { mergeCommit } = facts;
      if (typeof mergeCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(mergeCommit)) throw new TypeError('mergeCommit must be a git SHA');
      const branch = `rt/revert-${mergeCommit.slice(0, 7)}`;
      const revert = await git.createRevert({ mergeCommit, branch });
      await github.openRevertPullRequest({ branch, revert, title: `Revert ${mergeCommit.slice(0, 7)} after red main` });
    } else if (step.step === 'labels-restore') {
      await github.setLabels({ issue: step.issue, labels: step.labels });
    } else if (step.step === 'file-restore') {
      const abs = inside(step.path);
      const snap = snapshotFile(id, step.path);
      if (await sha256(abs) !== facts.postSha256) throw new Error(`file changed after the action: ${step.path}`);
      if (await sha256(snap) !== step.sha256) throw new Error(`snapshot hash mismatch: ${step.path}`);
      copyFileSync(snap, abs);
    } else if (step.step === 'issue-reopen') {
      await github.reopenIssue(step.issue);
    } else if (step.step === 'issue-close') {
      await github.closeIssue(step.issue);
    } else {
      throw new TypeError(`unknown revert step: ${step.step}`);
    }
  }

  async function rollback(id, { notify }) {
    const action = actions.get(id);
    if (!action) throw new Error(`unknown action: ${id}`);
    if (!['executed_pending_confirmation', 'revert_failed'].includes(states.get(id))) throw new Error(`cannot roll back from ${states.get(id)}`);
    if (!action.revert) throw new Error(`no revert recipe: ${id}`);
    state(id, 'rolling_back');
    for (const [i, step] of action.revert.entries()) {
      const key = `${id}:revert:${i}`;
      if (done.has(key)) continue;
      try {
        await runStep(id, step, executed.get(id));
      } catch (error) {
        state(id, 'revert_failed', { key, step: step.step, error: error.message });
        notify(notice(id, 'approval-request', 'revert_failed'));
        return { id, state: 'revert_failed' };
      }
      state(id, 'rolling_back', { key, ok: true });
    }
    state(id, 'rolled_back');
    return { id, state: 'rolled_back' };
  }

  function expire(at, ttlDays) {
    const expired = [];
    for (const [id, rec] of actions) {
      if (states.get(id) === 'executed_pending_confirmation' && rec.at < at - ttlDays * DAY) {
        state(id, 'expired');
        expired.push(id);
      }
    }
    return expired;
  }

  return { perform, rollback, expire, state: (id) => states.get(id) };
}
