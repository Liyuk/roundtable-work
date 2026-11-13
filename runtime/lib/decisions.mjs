import { readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const ASK_CATEGORIES = Object.freeze(['scope', 'credentials', 'destructive', 'direction']);
const DECISION_TYPES = Object.freeze(['do', 'continue', 'ask', 'out-of-scope', 'decompose']);

/** Validate the machine-readable end-of-turn decision before changing durable or tracker state. */
export function validateDecision(value) {
  if (!plain(value) || !DECISION_TYPES.includes(value.decision)) throw new TypeError('decision must be do, continue, ask, out-of-scope, or decompose');
  const allowed = value.decision === 'ask' ? ['decision', 'category', 'question']
    : value.decision === 'decompose' ? ['decision', 'drafts'] : ['decision', 'reason'];
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('decision has unexpected fields');
  if (value.decision === 'ask') {
    if (!ASK_CATEGORIES.includes(value.category)) throw new TypeError('ask category must be scope, credentials, destructive, or direction');
    if (!nonEmpty(value.question)) throw new TypeError('ask question is required');
  } else if (value.decision === 'decompose') {
    if (!Array.isArray(value.drafts) || value.drafts.length === 0 || value.drafts.length > 20 || value.drafts.some(path => typeof path !== 'string' || !path.trim())) throw new TypeError('decompose drafts must be a non-empty array of at most 20 relative paths');
    return { decision: value.decision, drafts: value.drafts.map(path => path.trim()) };
  } else if (!nonEmpty(value.reason)) throw new TypeError(`${value.decision} reason is required`);
  return { ...value };
}

/** Parse the decision-file text form: DECISION=<term>, then the ask category (for ask), then its text. */
export function parseDecisionFile(source) {
  if (typeof source !== 'string') throw new TypeError('decision file must be text');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines.at(-1) === '') lines.pop();
  const match = /^DECISION=(do|continue|ask|out-of-scope|decompose)$/.exec(lines.shift() ?? '');
  if (!match) throw new TypeError('decision file must start with DECISION=do, DECISION=continue, DECISION=ask, DECISION=out-of-scope, or DECISION=decompose');
  const decision = match[1];
  if (decision === 'ask') return validateDecision({ decision, category: lines.shift(), question: lines.join('\n') });
  if (decision === 'decompose') return validateDecision({ decision, drafts: lines });
  return validateDecision({ decision, reason: lines.join('\n') });
}

/** Apply one validated decision using durable state and the caller's injected tracker client. */
export async function applyDecision({ decision: raw, issue, store, client, repoRoot, now = Date.now,
  escalationAdapter, modelRouter, maxEscalationAttempts = 2 }) {
  let decision = typeof raw === 'string' ? parseDecisionFile(raw) : validateDecision(raw);
  const number = issue?.number ?? issue?.id;
  if (!Number.isSafeInteger(Number(number)) || Number(number) < 1) throw new TypeError('issue number is required');
  if (!store || typeof store.update !== 'function') throw new TypeError('state store is required');
  let queueNext = ['do', 'continue'].includes(decision.decision);
  if (!queueNext && decision.decision !== 'ask' && (!client || typeof client.createComment !== 'function' || typeof client.addLabel !== 'function' || typeof client.removeLabel !== 'function')) throw new TypeError('injected tracker client is required');
  const id = String(number);

  if (decision.decision === 'ask' && ['scope', 'direction'].includes(decision.category)) {
    if (!Number.isSafeInteger(maxEscalationAttempts) || maxEscalationAttempts < 1) throw new TypeError('maxEscalationAttempts must be a positive integer');
    const pending = (await store.load(id)).pendingDecision;
    const attempts = pending?.decision?.decision === 'ask' ? pending.attempts : 0;
    if (attempts >= maxEscalationAttempts) {
      await store.update(id, state => { state.pendingDecision = undefined; });
    } else {
      const waitForRetry = async detail => {
        await store.update(id, state => {
          state.status = 'waiting_external';
          state.lastEvent = { type: 'decision_escalation_failed', at: now(), detail };
        });
        return { status: 'waiting_external', decision: 'wait', escalation: 'pending' };
      };
      if (typeof escalationAdapter !== 'function') {
        await store.update(id, state => { state.pendingDecision = { decision, attempts }; });
        return await waitForRetry('escalation adapter unavailable');
      }
      const attempt = attempts + 1;
      await store.update(id, state => { state.pendingDecision = { decision, attempts: attempt }; });
      let resolved;
      try {
        if (typeof modelRouter !== 'function') throw new TypeError('model router is required for escalation');
        resolved = await escalationAdapter({ decision, issue, model: modelRouter('escalation'), attempt });
        if (resolved !== null && resolved !== undefined) decision = validateDecision(resolved);
      } catch (error) {
        return await waitForRetry(error?.message ?? String(error));
      }
      if (resolved === null || resolved === undefined) return await waitForRetry('adapter returned no resolution');
      queueNext = ['do', 'continue'].includes(decision.decision);
      await store.update(id, state => { state.pendingDecision = undefined; });
    }
  }
  if (!['do', 'continue'].includes(decision.decision)
    && (!client || typeof client.createComment !== 'function' || typeof client.addLabel !== 'function' || typeof client.removeLabel !== 'function')) throw new TypeError('injected tracker client is required');

  if (decision.decision === 'decompose') {
    if (typeof repoRoot !== 'string' || typeof client.createIssue !== 'function') throw new TypeError('repoRoot and injected tracker createIssue are required for decompose');
    const drafts = await Promise.all(decision.drafts.map(path => readDraft(repoRoot, path)));
    await store.update(id, state => {
      state.decomposition = { status: 'creating', drafts, childIds: [], inFlight: false };
      state.status = 'waiting_external';
    });
    const childIds = await resumeDecomposition({ number, store, client, now });
    return { status: 'waiting_external', decision: decision.decision, childIds };
  }

  if (queueNext) {
    await store.update(id, state => {
      state.status = 'queued'; state.phase = null; state.checkpoint = null; state.pause = undefined;
      state.lastEvent = { type: `decision_${decision.decision}`, at: now(), detail: decision.reason };
    });
    if (client) await clearPauseLabels(client, number);
    return { status: 'queued', decision: decision.decision };
  }

  const asking = decision.decision === 'ask';
  const marker = asking ? '<!-- rt:ask -->' : '<!-- rt:out-of-scope -->';
  const body = asking
    ? `${marker}\nDECISION=ask\n${decision.category}\n${decision.question}`
    : `${marker}\nDECISION=out-of-scope\n${decision.reason}`;
  // A pause belongs to the comment generated by this decision. Reusing an older
  // marker would let a reply to an earlier ask satisfy this pause.
  const comment = await client.createComment(number, body);
  if (asking) await client.addLabel(number, 'rt:ask');
  else await client.addLabel(number, 'rt:blocked');
  await client.removeLabel(number, 'rt:running');
  await store.update(id, state => {
    state.status = asking ? 'waiting_person' : 'out-of-scope';
    state.pause = { kind: decision.decision, category: asking ? decision.category : undefined,
      pausedAt: now(), commentId: comment?.id ?? null, commentCreatedAt: comment?.createdAt ?? null };
    state.lastEvent = { type: `decision_${decision.decision}`, at: now(), detail: asking ? decision.question : decision.reason };
  });
  return { status: asking ? 'waiting_person' : 'out-of-scope', decision: decision.decision };
}

/** Continue only creation steps whose previous tracker outcome is known. */
export async function resumeDecomposition({ number, store, client, now = Date.now }) {
  const id = String(number);
  let decomposition = (await store.load(id)).decomposition;
  if (decomposition?.status !== 'creating' || !Array.isArray(decomposition.drafts)
    || decomposition.drafts.length === 0 || decomposition.drafts.length > 20
    || decomposition.drafts.some(draft => !plain(draft) || !nonEmpty(draft.title) || !nonEmpty(draft.body))
    || !Array.isArray(decomposition.childIds) || decomposition.childIds.length > decomposition.drafts.length
    || decomposition.childIds.some(child => !Number.isSafeInteger(child) || child < 1)
    || new Set(decomposition.childIds).size !== decomposition.childIds.length) return null;
  await client.addLabel(number, 'rt:hold');
  for (const child of decomposition.childIds) await client.addLabel(child, 'rt:self');
  // A failed or interrupted create may have succeeded remotely. Never retry it blindly.
  if (decomposition.inFlight !== false) return null;
  while (decomposition.childIds.length < decomposition.drafts.length) {
    const draft = decomposition.drafts[decomposition.childIds.length];
    await store.update(id, state => { state.decomposition.inFlight = true; });
    const created = await client.createIssue(draft.title, draft.body);
    const child = Number(created?.number ?? created?.id);
    if (!Number.isSafeInteger(child) || child < 1 || decomposition.childIds.includes(child)) throw new TypeError('tracker did not return a valid child issue number');
    await store.update(id, state => { state.decomposition.childIds.push(child); state.decomposition.inFlight = false; });
    decomposition = (await store.load(id)).decomposition;
    await client.addLabel(child, 'rt:self');
  }
  const childIds = decomposition.childIds;
  await store.update(id, state => {
    state.decomposition.status = 'waiting'; state.status = 'waiting_external';
    state.lastEvent = { type: 'decision_decompose', at: now(), detail: childIds };
  });
  return childIds;
}

async function readDraft(repoRoot, path) {
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')) throw new TypeError(`Draft path must be safe relative: ${path}`);
  const root = await realpath(resolve(repoRoot));
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || rel.split(sep).includes('..')) throw new TypeError(`Draft path must be safe relative: ${path}`);
  const actual = await realpath(absolute);
  const actualRel = relative(root, actual);
  if (actualRel === '..' || actualRel.startsWith(`..${sep}`)) throw new TypeError(`Draft path must be safe relative: ${path}`);
  let draft;
  try { draft = JSON.parse(await readFile(actual, 'utf8')); } catch (error) { throw new TypeError(`Draft ${path} must be readable JSON: ${error.message}`); }
  if (!plain(draft) || !nonEmpty(draft.title) || !nonEmpty(draft.body)) throw new TypeError(`Draft ${path} requires non-empty title and body`);
  return { title: draft.title.trim(), body: draft.body.trim() };
}

/** Resume a paused issue only after its owner has posted after the pause comment. */
export async function resumeAfterOwnerReply({ issue, comments, store, client, now = Date.now }) {
  if (!Array.isArray(comments)) throw new TypeError('comments must be an array');
  const number = Number(issue?.number ?? issue?.id);
  const id = String(number);
  const state = await store.load(id);
  if (!state.pause || !['waiting_person', 'out-of-scope'].includes(state.status)) return false;
  const owner = issue?.author?.login;
  if (typeof owner !== 'string' || !owner) return false;
  const pausedAt = Date.parse(state.pause.commentCreatedAt ?? '') || state.pause.pausedAt;
  const hasPauseCommentId = state.pause.commentId != null;
  // Tracker timestamps have second precision. Without the pause comment ID,
  // include replies in the pause's second so a same-second owner reply is not
  // lost to the millisecond pause timestamp recorded locally.
  const replyCutoff = hasPauseCommentId ? pausedAt : Math.floor(pausedAt / 1000) * 1000;
  const replied = comments.some(comment => comment?.author?.login?.toLowerCase() === owner.toLowerCase()
    && (hasPauseCommentId ? Date.parse(comment.createdAt ?? '') > replyCutoff : Date.parse(comment.createdAt ?? '') >= replyCutoff)
    && (!hasPauseCommentId || Number(comment.id) > Number(state.pause.commentId)));
  if (!replied) return false;
  await store.update(id, current => {
    current.status = 'queued'; current.phase = null; current.checkpoint = null; current.pause = undefined;
    current.lastEvent = { type: 'owner_reply_resumed', at: now() };
  });
  await clearPauseLabels(client, number);
  return true;
}

async function clearPauseLabels(client, number) {
  await client.removeLabel(number, 'rt:ask');
  await client.removeLabel(number, 'rt:blocked');
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

export { ASK_CATEGORIES, DECISION_TYPES };
