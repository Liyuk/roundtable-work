import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

export const ASK_CATEGORIES = Object.freeze(['scope', 'credentials', 'destructive', 'direction']);
export const MODEL_ROUTING = Object.freeze({
  chief: 'tokenarmy/claude-sonnet-5-5',
  development: 'tokenarmy/claude-sonnet-5-5',
  review: 'tokenarmy/claude-sonnet-5-5',
  verification: 'tokenarmy/claude-sonnet-5-5',
  escalation: 'tokenarmy/claude-opus-5-5',
  crosscheck: 'gpt-6.1-terra',
});
export const DECISION_OUTCOMES = Object.freeze(['do', 'decompose', 'ask', 'out-of-scope']);
const VALID_MODELS = new Set(['tokenarmy/claude-sonnet-5-5', 'tokenarmy/claude-opus-5-5', 'gpt-6.1-terra']);

export function routeModel(workType, routing = MODEL_ROUTING) {
  if (!routing || typeof routing !== 'object' || Array.isArray(routing)) throw new TypeError('model routing must be an object');
  for (const [type, model] of Object.entries(routing)) {
    if (!['chief', 'development', 'review', 'verification', 'escalation', 'crosscheck'].includes(type) || !VALID_MODELS.has(model)) {
      throw new TypeError(`Invalid model routing entry: ${type}`);
    }
  }
  if (!Object.hasOwn(routing, workType)) throw new TypeError(`Unknown work type: ${String(workType)}`);
  return routing[workType];
}

async function safeDraftPath(root, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new TypeError('draft path must be relative');
  const realRoot = await realpath(root);
  const target = await realpath(resolve(root, path));
  const rel = relative(realRoot, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new TypeError('draft path escapes worktree');
  return target;
}

export async function readDecisionFile(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  validateDecision(raw);
  return raw;
}

export function validateDecision(decision) {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || !DECISION_OUTCOMES.includes(decision.outcome)) throw new TypeError('Invalid decision outcome');
  if (decision.outcome === 'ask' && !ASK_CATEGORIES.includes(decision.category)) throw new TypeError(`Invalid ask category: ${String(decision.category)}`);
  if (['ask', 'out-of-scope'].includes(decision.outcome) && (typeof decision.reason !== 'string' || !decision.reason.trim())) throw new TypeError('Decision reason is required');
  if (decision.outcome === 'decompose' && (!Array.isArray(decision.drafts) || !decision.drafts.length)) throw new TypeError('decompose requires draft files');
  return decision;
}

function requireClient(client, methods) {
  if (!client || methods.some(name => typeof client[name] !== 'function')) throw new TypeError(`GitHub client must implement ${methods.join(', ')}`);
}

/** Apply one validated Chief decision. All tracker effects go through the injected client. */
export async function applyDecision({ decision: input, issue, client, state, maxDecisions = 2, escalate, worktreeRoot }) {
  let decision = validateDecision(input);
  if (!issue || !Number.isSafeInteger(Number(issue.number ?? issue.id))) throw new TypeError('issue number is required');
  const id = Number(issue.number ?? issue.id);
  if (!state || typeof state !== 'object') throw new TypeError('durable state is required');
  if (!Number.isSafeInteger(maxDecisions) || maxDecisions < 1) throw new TypeError('maxDecisions must be a positive integer');
  state.attempts ??= {};
  state.attempts.decisions ??= 0;

  if (decision.outcome === 'ask' && ['scope', 'direction'].includes(decision.category) && state.attempts.decisions < maxDecisions && typeof escalate === 'function') {
    state.attempts.decisions++;
    let escalated;
    try { escalated = await escalate({ decision, issue, model: routeModel('escalation') }); }
    catch (error) {
      state.status = 'waiting_external'; state.escalationPending = true; state.pendingDecision = decision;
      return { status: 'waiting_external', decision: 'wait', reason: 'escalation_failed', detail: error.message };
    }
    if (escalated) decision = validateDecision(escalated);
  } else if (decision.outcome === 'ask' && ['scope', 'direction'].includes(decision.category) && state.attempts.decisions < maxDecisions) {
    state.status = 'waiting_external'; state.escalationPending = true; state.pendingDecision = decision;
    return { status: 'waiting_external', decision: 'wait', reason: 'escalation_unavailable', model: routeModel('escalation') };
  }

  if (decision.outcome === 'do') {
    requireClient(client, ['removeLabel']);
    for (const label of ['rt:ask', 'rt:blocked']) await client.removeLabel(id, label);
    state.status = 'queued'; state.nextTurn = true; state.pauseReason = null;
    return { status: 'queued', decision: 'continue', nextTurn: true };
  }
  if (decision.outcome === 'decompose') {
    requireClient(client, ['createIssue', 'addLabel']);
    if (!worktreeRoot) throw new TypeError('worktreeRoot is required to read decomposition drafts');
    const children = [];
    for (const draftPath of decision.drafts) {
      const draft = JSON.parse(await readFile(await safeDraftPath(worktreeRoot, draftPath), 'utf8'));
      if (typeof draft.title !== 'string' || !draft.title.trim() || typeof draft.body !== 'string') throw new TypeError('Each draft file must contain title and body');
      const child = await client.createIssue({ title: draft.title, body: draft.body, parent: id });
      await client.addLabel(child.number, 'rt:self');
      children.push(Number(child.number));
    }
    await client.addLabel(id, 'rt:hold');
    state.status = 'waiting_external'; state.childIssues = children; state.nextTurn = false;
    return { status: 'decomposed', childIssues: children };
  }
  if (decision.outcome === 'ask') {
    requireClient(client, ['createComment', 'addLabel']);
    const priorComments = typeof client.listComments === 'function' ? await client.listComments(id) : [];
    await client.createComment(id, `Decision needed (${decision.category}): ${decision.reason}`);
    await client.addLabel(id, 'rt:ask');
    state.status = 'waiting_person'; state.pauseReason = { category: decision.category, reason: decision.reason };
    state.pauseCommentCount = priorComments.length;
    return { status: 'waiting_person', decision: 'ask' };
  }
  requireClient(client, ['createComment', 'addLabel']);
  const priorComments = typeof client.listComments === 'function' ? await client.listComments(id) : [];
  await client.createComment(id, `Out of scope: ${decision.reason}`);
  await client.addLabel(id, 'rt:blocked');
  state.status = 'out-of-scope'; state.pauseReason = { reason: decision.reason };
  state.pauseCommentCount = priorComments.length;
  return { status: 'out-of-scope', decision: 'ask' };
}

/** Resume only when a new comment from the issue author arrived after the pause was recorded. */
export async function resumeOnOwnerReply({ state, issue, client }) {
  if (!['waiting_person', 'out-of-scope'].includes(state?.status) || !issue?.author?.login || typeof client?.listComments !== 'function') return false;
  const comments = await client.listComments(issue.number ?? issue.id);
  const baseline = Number.isSafeInteger(state.pauseCommentCount) ? state.pauseCommentCount : comments.length;
  const owner = issue.author.login.toLowerCase();
  if (!comments.slice(baseline).some(comment => (comment.user?.login ?? comment.author?.login ?? '').toLowerCase() === owner)) return false;
  for (const label of ['rt:ask', 'rt:blocked']) await client.removeLabel(issue.number ?? issue.id, label);
  state.status = 'queued'; state.nextTurn = true; state.pauseReason = null; state.pauseCommentCount = null;
  return true;
}

/** Release a held parent only after every recorded child is closed. */
export async function releaseParentWhenChildrenClose({ state, getIssue, client, parentNumber }) {
  if (!Array.isArray(state?.childIssues) || !state.childIssues.length) return false;
  const children = await Promise.all(state.childIssues.map(getIssue));
  if (!children.every(child => String(child?.state).toUpperCase() === 'CLOSED')) return false;
  await client.removeLabel(parentNumber, 'rt:hold');
  await client.removeLabel(parentNumber, 'rt:blocked');
  state.status = 'queued'; state.nextTurn = true; state.pauseReason = null;
  return true;
}
