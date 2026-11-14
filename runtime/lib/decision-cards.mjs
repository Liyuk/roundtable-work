// Decision cards (RT-F-3, issue #262): a card either resolves inside the line (non-closed category, provider decides)
// or suspends only that line (closed category, provider failure, or invalid choice). Approval arrives later as an inbox event.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { ASK_CATEGORIES } from './machine.mjs';

const CARD_FIELDS = ['issue', 'category', 'question', 'options', 'recommendation', 'evidence'];
const nonEmpty = (s) => typeof s === 'string' && s.length > 0;

function validateCard(card) {
  for (const key of Object.keys(card)) {
    if (!CARD_FIELDS.includes(key)) throw new TypeError(`unknown card field: ${key}`);
  }
  if (!Number.isInteger(card.issue) || card.issue <= 0) throw new TypeError('issue must be a positive integer');
  if (card.category !== undefined && typeof card.category !== 'string') throw new TypeError('category must be a string');
  if (!nonEmpty(card.question)) throw new TypeError('question must be a non-empty string');
  if (!Array.isArray(card.options) || card.options.length < 2 || !card.options.every(nonEmpty)) {
    throw new TypeError('options must be at least 2 non-empty strings');
  }
  if (!card.options.includes(card.recommendation)) throw new TypeError('recommendation must be one of options');
  if (!Array.isArray(card.evidence) || card.evidence.length < 1 || !card.evidence.every(nonEmpty)) {
    throw new TypeError('evidence must be at least 1 non-empty string');
  }
}

const linePath = (root, issue) => join(root, '.roundtable/state/lines', `${issue}.json`);

export async function readLine(root, issue) {
  try {
    return JSON.parse(await readFile(linePath(root, issue), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { status: 'idle', sessionId: null, slot: null, decisions: [], failures: {}, fixes: {}, pending: null };
  }
}

async function writeLine(root, issue, line) {
  const file = linePath(root, issue);
  const tmp = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(tmp, JSON.stringify(line, null, 2) + '\n');
  await rename(tmp, file);
}

export async function startLine({ root, issue, sessionId }) {
  const line = await readLine(root, issue);
  Object.assign(line, { status: 'running', sessionId, slot: 'worker' });
  await writeLine(root, issue, line);
}

async function suspend(root, line, card, reason) {
  const { category = null, question, options, recommendation, evidence } = card;
  Object.assign(line, { status: 'suspended', slot: null, pending: { category, question, options, recommendation, evidence, reason } });
  await writeLine(root, card.issue, line);
  return { status: 'suspended' };
}

export async function routeCard({ root, card, provider, closedList = ASK_CATEGORIES, now = Date.now }) {
  validateCard(card);
  const line = await readLine(root, card.issue);
  if (closedList.includes(card.category)) return suspend(root, line, card, `category:${card.category}`);

  let decision;
  try {
    decision = await provider.decide({ card });
  } catch (err) {
    return suspend(root, line, card, `provider error: ${err.message}`);
  }
  if (!card.options.includes(decision?.choice)) return suspend(root, line, card, 'invalid provider choice');

  const { choice, reason, source } = decision;
  line.decisions.push({ question: card.question, choice, reason, source, at: now() });
  Object.assign(line, { status: 'running', slot: 'worker', pending: null });
  await writeLine(root, card.issue, line);
  return { status: 'resumed', choice };
}

export async function recordFailure({ root, issue, signature, source = 'chief', now = Date.now }) {
  const line = await readLine(root, issue);
  const count = (line.failures[signature] ?? 0) + 1;
  line.failures[signature] = count;
  if (count === 1) {
    line.fixes[signature] = { action: 'retry', source, at: now() };
    await writeLine(root, issue, line);
    return { status: 'running', fixed: true };
  }
  if (line.fixes[signature] === undefined) {
    await writeLine(root, issue, line);
    return { status: 'stopped' };
  }
  await writeLine(root, issue, line);
  return { status: 'running', repeated: true, fixed: true };
}

export async function resumeFromApproval({ root, inbox, event, now = Date.now }) {
  if (!inbox.accept(event)) return { status: 'duplicate' };
  const line = await readLine(root, event.issue);
  const decision = event.payload?.decision;
  if (line.status !== 'suspended' || event.kind !== 'owner_comment' || !['approve', 'reject'].includes(decision)) {
    return { status: 'ignored' };
  }
  if (decision === 'reject') {
    line.decisions.push({ question: line.pending.question, choice: 'reject', reason: 'owner rejected', source: 'owner', at: now() });
  }
  Object.assign(line, { status: 'running', slot: 'worker', pending: null });
  await writeLine(root, event.issue, line);
  return { status: 'resumed', sessionId: line.sessionId };
}
