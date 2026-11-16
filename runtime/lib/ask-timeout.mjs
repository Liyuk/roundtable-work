// RT-S13c (docs/self-supervision.md, section (d)). A suspended reversible ask whose recommendation is still unresolved after
// `askTimeoutMs` runs that recommendation: a `decision` action through the action journal (with a file-restore rollback) and a
// `self` ledger entry. Red-line categories and goal changes never run by default. Owner answers are counted per kind; a third
// answer records a standing-rule proposal, which stays inert until an owner confirmation record flips it.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { autonomyTier } from './autonomy.mjs';
import { askHash, notifyAction } from './daemon-asks.mjs';
import { isGoalChange } from './ask-policy.mjs';
import { readLine } from './decision-cards.mjs';
import { recordAsk } from './ask-ledger.mjs';

export const ASK_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RED_LINE = Object.freeze(['credentials', 'destructive', 'production']);
const STANDING_ANSWERS = 3;
const LINES_DIR = '.roundtable/state/lines';
const STANDING_PATH = '.roundtable/state/standing-rules.json';

const linePath = (root, issue) => join(root, LINES_DIR, `${issue}.json`);
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
};

/** Stamps a suspended line with when its ask was first suspended (`since` keeps an unchanged ask's clock) and the Chief's scopeKind. */
export async function stampSuspension({ root, issue, scopeKind, now, since }) {
  const line = await readLine(root, issue);
  Object.assign(line.pending, { at: since ?? now(), scopeKind });
  writeJson(linePath(root, issue), line);
}

const isRedLine = (card) => RED_LINE.includes(card.category) || isGoalChange(card);

/**
 * Runs the recommendation of every suspended, reversible ask that has waited `askTimeoutMs`. Each run is a journal action
 * (`act:decision:<issue>:<hash>`, rollback restores the suspended line) and one `self` decision entry. A rolled-back ask is not
 * run again.
 */
export async function sweepAskTimeouts({ root, policy, now = Date.now, askTimeoutMs = ASK_TIMEOUT_MS }) {
  const dir = join(root, LINES_DIR);
  if (!existsSync(dir)) return;
  const t = now();
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const issue = Number(name.slice(0, -'.json'.length));
    const { status, pending } = await readLine(root, issue);
    if (status !== 'suspended' || !pending?.at || t - pending.at < askTimeoutMs || isRedLine(pending)) continue;
    const { question, recommendation } = pending;
    const key = askHash(question);
    const id = `act:decision:${issue}:${key}`;
    if (policy.journal.state(id)) continue;

    const action = { kind: 'decision', issue, key, labels: [], paths: [], plan: { rule: 'ask-timeout', choice: recommendation }, before: { file: `${LINES_DIR}/${issue}.json` } };
    const { tier, reasons } = autonomyTier(action, policy.autonomy);
    if (tier === 'approve-first') continue;
    const apply = async () => {
      const line = await readLine(root, issue);
      line.decisions.push({ question, choice: recommendation, reason: 'ask timed out: recommended option', source: 'timeout-default', at: t });
      Object.assign(line, { status: 'running', slot: 'worker', pending: null });
      writeJson(linePath(root, issue), line);
    };
    const { state } = await policy.journal.perform({ action: { ...action, reasons }, tier, apply, notify: notifyAction(root, issue) });
    policy.ledger.append({ category: 'decision', ref: `#${issue}`, reason: 'ask timed out: recommended option executed', internalized: 'no', source: 'self' }, { key: id });
    if (state !== 'rolled_back') recordAsk(root, { issue, key, route: 'supervisor', at: t });
  }
}

const normalize = (question) => String(question).toLowerCase().replace(/\d+/g, '#').replace(/[^a-z#]+/g, ' ').trim();
/** The standing-rule kind of an ask: its category plus the normalised question (digits become `#`). */
export const standingKind = (category, question) => `${category}: ${normalize(question)}`;

const readStanding = (root) => (existsSync(join(root, STANDING_PATH)) ? JSON.parse(readFileSync(join(root, STANDING_PATH), 'utf8')) : {});

/** Counts one owner answer. The third answer of a kind records a `proposed` standing rule; nothing consults it yet. */
export function recordOwnerAnswer({ root, category, question }) {
  const rules = readStanding(root);
  const kind = standingKind(category, question);
  const rule = rules[kind] ?? { kind, answers: 0 };
  rule.answers += 1;
  if (rule.answers === STANDING_ANSWERS) rule.status = 'proposed';
  rules[kind] = rule;
  writeJson(join(root, STANDING_PATH), rules);
}

/** The owner's explicit confirmation record: the only way a proposal becomes `confirmed`. */
export function confirmStandingRule({ root, kind, owner }) {
  const rules = readStanding(root);
  if (rules[kind]?.status !== 'proposed') throw new Error(`no proposed standing rule: ${kind}`);
  Object.assign(rules[kind], { status: 'confirmed', confirmedBy: owner });
  writeJson(join(root, STANDING_PATH), rules);
}
