// Chief session bridge: an interactive owner session reads daemon status and writes owner commands into the event inbox.
// A command becomes the same owner_comment event a GitHub `/rt` comment produces, so the daemon handles both alike.
// The module keeps no state of its own: it reads the daemon files and appends to the inbox.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openInbox } from './event-inbox.mjs';
import { openActionJournal } from './action-journal.mjs';
import { parseRtCommand } from './rt-commands.mjs';
import { ownerOf } from './daemon-cards.mjs';
import { loopWorkspace } from './daemon-loop.mjs';
import { readLine } from './decision-cards.mjs';
import { DEFAULT_POLL_MS } from './daemon-loop.mjs';
import { GAP_FACTOR } from './liveness.mjs';
import { HEARTBEAT_PATH, parseHeartbeat } from '../supervisor/heartbeat.mjs';

const LINES_DIR = '.roundtable/state/lines';

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/** Pending decision cards: suspended lines that carry a pending question. */
async function pendingCards(root) {
  const dir = join(root, LINES_DIR);
  if (!existsSync(dir)) return [];
  const cards = [];
  for (const file of readdirSync(dir).filter((name) => /^\d+\.json$/.test(name))) {
    const issue = Number(file.slice(0, -'.json'.length));
    const line = await readLine(root, issue);
    if (line.status === 'suspended' && line.pending) {
      const { category, question, recommendation } = line.pending;
      cards.push({ issue, category, question, recommendation });
    }
  }
  return cards.sort((a, b) => a.issue - b.issue);
}

/** Read-only snapshot: whether the daemon heartbeat is fresh, actions awaiting confirmation, and pending decision cards. */
export async function chiefStatus({ root, now = Date.now }) {
  const heartbeat = parseHeartbeat(readText(join(root, HEARTBEAT_PATH)));
  const fresh = heartbeat.ok && heartbeat.value.daemon.state === 'running'
    && now() - heartbeat.value.daemon.lastCycleAt <= GAP_FACTOR * DEFAULT_POLL_MS;
  const pendingConfirmation = openActionJournal(root).list()
    .filter((a) => a.state === 'executed_pending_confirmation')
    .map((a) => ({ id: a.id, issue: a.issue, kind: a.kind }));
  return { running: fresh, pendingConfirmation, decisionCards: await pendingCards(root) };
}

/**
 * Validates an owner command with the same parser as GitHub `/rt` comments, then appends it to the inbox as an owner_comment.
 * Resolves { accepted, source_event_id }; `accepted` is false when the same normalized command was already in the inbox.
 */
export async function chiefSay({ root, owner, command, now = Date.now }) {
  if (typeof owner !== 'string' || owner === '') throw new TypeError('owner is unknown; pass --repo OWNER/REPO');
  const body = `/rt ${command.trim()}`;
  const parsed = parseRtCommand(body);
  if (!parsed.ok) throw new TypeError(parsed.reason);
  const issue = parsed.actionId === undefined ? null
    : openActionJournal(root).list().find((a) => a.id === parsed.actionId)?.issue ?? null;
  const source_event_id = `chief-session:${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
  const accepted = openInbox(root).accept({ source_event_id, kind: 'owner_comment', issue, payload: { body, author: owner }, receivedAt: now() });
  return { accepted, source_event_id };
}

/** `chief status [--json]` and `chief say <command...>`: the owner session's view of, and input to, the daemon. Returns the exit code. */
export async function runChiefCli(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' }, repo: { type: 'string' }, 'work-root': { type: 'string' } } });
  const root = loopWorkspace(values['work-root'] ?? '.roundtable');
  if (!root) {
    console.error('chief: --work-root must be a directory named .roundtable');
    return 2;
  }
  const [sub, ...rest] = positionals;
  if (sub === 'status') {
    const status = await chiefStatus({ root });
    if (values.json) console.log(JSON.stringify(status));
    else console.log([`running: ${status.running ? 'yes' : 'no'}`, ...status.pendingConfirmation.map((a) => `confirm: ${a.id} (issue #${a.issue})`), ...status.decisionCards.map((c) => `decision: #${c.issue} ${c.category ?? ''} ${c.question}`)].join('\n'));
    return 0;
  }
  if (sub === 'say' && rest.length > 0) {
    try {
      console.log(JSON.stringify(await chiefSay({ root, owner: ownerOf(values.repo ?? process.env.GITHUB_REPOSITORY), command: rest.join(' '), now: Date.now })));
      return 0;
    } catch (error) {
      console.error(`chief say: ${error.message}`);
      return 2;
    }
  }
  console.error('usage: rtd.mjs chief status [--json] [--work-root DIR] | rtd.mjs chief say <command...> [--repo OWNER/REPO] [--work-root DIR]');
  return 2;
}
