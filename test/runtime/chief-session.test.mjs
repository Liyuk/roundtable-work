import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chiefSay, chiefStatus } from '../../runtime/lib/chief-session.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openActionJournal } from '../../runtime/lib/action-journal.mjs';
import { routeCard } from '../../runtime/lib/decision-cards.mjs';
import { ASK_CATEGORIES } from '../../runtime/lib/machine.mjs';
import { cycleSteps } from '../../runtime/lib/daemon-loop.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { HEARTBEAT_PATH, writeHeartbeat } from '../../runtime/supervisor/heartbeat.mjs';

const NOW = 1_700_000_000_000;
const OWNER = 'owner-login';

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'chief-session-test-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

const inboxEvents = (root) => openInbox(root).events();

// An executed (non-auto-silent) action on issue 5, ready for confirmation.
const executeAction = async (root, key = 'k1') => {
  const journal = openActionJournal(root, { now: () => NOW });
  const { id } = await journal.perform({
    action: { kind: 'config-change', issue: 5, key, reasons: [], plan: {}, before: {} },
    tier: 'auto-notify', notify: () => {}, apply: async () => ({}),
  });
  return id;
};

test('chief say confirm produces the same inbox event shape as the GitHub /rt confirm path', async () => {
  await withRoot(async (root) => {
    const id = await executeAction(root);
    assert.equal((await chiefSay({ root, owner: OWNER, command: `confirm ${id}`, now: () => NOW })).accepted, true);
    const [chief] = inboxEvents(root);
    // Same shape as produceEvents writes for a GitHub owner comment (daemon-events.mjs): kind, issue, payload keys.
    const github = { source_event_id: 'gh-comment:1', kind: 'owner_comment', issue: 5, payload: { body: `/rt confirm ${id}`, author: OWNER }, receivedAt: NOW };
    assert.equal(chief.kind, github.kind);
    assert.equal(chief.issue, github.issue);
    assert.deepEqual(Object.keys(chief.payload).sort(), Object.keys(github.payload).sort());
    assert.deepEqual(chief.payload, { body: `/rt confirm ${id}`, author: OWNER });
    assert.match(chief.source_event_id, /^chief-session:[0-9a-f]{16}$/);
  });
});

test('a repeated chief say is dropped by inbox dedupe and writes one event', async () => {
  await withRoot(async (root) => {
    const id = await executeAction(root);
    const first = await chiefSay({ root, owner: OWNER, command: `confirm ${id}`, now: () => NOW });
    const again = await chiefSay({ root, owner: OWNER, command: `  confirm ${id}  `, now: () => NOW });
    assert.equal(first.accepted, true);
    assert.equal(again.accepted, false);
    assert.equal(again.source_event_id, first.source_event_id);
    assert.equal(inboxEvents(root).length, 1);
  });
});

test('chief say rejects an invalid command and writes nothing', async () => {
  await withRoot(async (root) => {
    await assert.rejects(chiefSay({ root, owner: OWNER, command: 'merge 5', now: () => NOW }), /merge is not accepted|unknown/);
    await assert.rejects(chiefSay({ root, owner: OWNER, command: 'confirm', now: () => NOW }), /wrong arguments/);
    assert.equal(readdirSync(root).length, 0);
  });
});

test('chief say without an owner is rejected and writes nothing', async () => {
  await withRoot(async (root) => {
    await assert.rejects(chiefSay({ root, owner: '', command: 'pause', now: () => NOW }), /owner/);
    assert.equal(readdirSync(root).length, 0);
  });
});

test('chief say for a non-action command has no issue', async () => {
  await withRoot(async (root) => {
    await chiefSay({ root, owner: OWNER, command: 'pause', now: () => NOW });
    assert.deepEqual(inboxEvents(root)[0].payload, { body: '/rt pause', author: OWNER });
    assert.equal(inboxEvents(root)[0].issue, null);
  });
});

test('chief status --json lists pending-confirmation actions and pending decision cards', async () => {
  await withRoot(async (root) => {
    const id = await executeAction(root);
    await routeCard({ root, card: { issue: 9, category: ASK_CATEGORIES[0], question: 'Proceed?', options: ['approve', 'reject'], recommendation: 'reject', evidence: ['e'] }, provider: { decide: async () => { throw new Error('none'); } } });
    const status = await chiefStatus({ root, now: () => NOW });
    assert.deepEqual(status.pendingConfirmation.map((a) => [a.id, a.issue]), [[id, 5]]);
    assert.deepEqual(status.decisionCards.map((c) => [c.issue, c.question]), [[9, 'Proceed?']]);
    assert.equal(status.running, false);
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  });
});

test('chief status reports running only for a fresh daemon heartbeat and writes nothing', async () => {
  await withRoot(async (root) => {
    mkdirSync(join(root, HEARTBEAT_PATH, '..'), { recursive: true });
    writeHeartbeat({ schemaVersion: 1, writtenAt: NOW, daemon: { pid: 1, lastCycleAt: NOW, state: 'running' }, frontChief: { session: 'none', lastTurnAt: 0, state: 'gone' }, lastMaterialProgress: null },
      { write: (path, text) => writeFileSync(join(root, path), text) });
    const before = readFileSync(join(root, HEARTBEAT_PATH), 'utf8');
    assert.equal((await chiefStatus({ root, now: () => NOW })).running, true);
    assert.equal((await chiefStatus({ root, now: () => NOW + 60 * 60_000 })).running, false);
    assert.equal(readFileSync(join(root, HEARTBEAT_PATH), 'utf8'), before);
  });
});

test('a daemon cycle completes in a fresh workspace where no chief command was ever issued', async () => {
  await withRoot(async (root) => {
    const inbox = openInbox(root);
    const dispatched = [];
    await cycleSteps({ root, inbox, timers: openTimers(root), now: NOW, dispatchLine: async (batch) => { dispatched.push(batch); } });
    assert.deepEqual(dispatched, []);
    assert.equal(inbox.events().length, 0);
  });
});

test('the chief module has no harness-specific references', () => {
  const source = readFileSync(new URL('../../runtime/lib/chief-session.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(pi|codex|claude|harness|adapter)\b/i);
});
