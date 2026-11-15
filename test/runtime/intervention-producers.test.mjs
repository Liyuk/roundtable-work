import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyOwnerEvent, DEFAULT_EXTERNAL_PREFIXES, recordOwnerEvent } from '../../runtime/lib/intervention-producers.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';
import { produceEvents } from '../../runtime/lib/daemon-events.mjs';
import { cycleSteps } from '../../runtime/lib/daemon-loop.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { createActuator } from '../../runtime/supervisor/actuator.mjs';
import { createLedger } from '../../runtime/supervisor/ledger.mjs';

const owner = 'owner-user';
const comment = (body, author = owner) => ({ kind: 'owner_comment', payload: { body, author } });
const line = (over = {}) => ({ status: 'working', labels: [], pause: null, ...over });
const classify = (body, lineState = line(), author = owner) => classifyOwnerEvent({ event: comment(body, author), line: lineState, owner });
const entry = (category, extra = {}) => ({ category, source: 'owner', ...extra });

test('/rt commands map to ledger categories; /rt status and unknown text are not interventions', () => {
  assert.deepEqual(classify('/rt pause'), { ...entry('liveness'), kind: 'pause' });
  assert.deepEqual(classify('/rt resume'), { ...entry('liveness'), kind: 'resume' });
  assert.deepEqual(classify('/rt requeue'), entry('merge'));
  assert.equal(classify('/rt status'), null);
  assert.equal(classify('/rt merge'), null);
  assert.equal(classify('hello'), null);
});

test('a comment on a pending ask is a decision; on a blocked line a merge; on a terminal line a self-review; added acceptance on an open line a backlog', () => {
  assert.deepEqual(classify('Use option A', line({ pause: { kind: 'ask' }, labels: ['rt:ask'] })), entry('decision'));
  assert.deepEqual(classify('Retry please', line({ status: 'blocked', labels: ['rt:blocked'] })), entry('merge'));
  assert.deepEqual(classify('Please look again', line({ status: 'done' })), entry('self-review'));
  assert.deepEqual(classify('Acceptance: also run the linter', line({ status: 'working' })), entry('backlog'));
});

test('an ordinary comment on an open line that adds no acceptance is not an intervention', () => {
  assert.equal(classify('thanks', line({ status: 'working' })), null);
});

test('comments by anyone other than the owner are not interventions', () => {
  assert.equal(classify('/rt pause', line(), 'someone-else'), null);
  assert.equal(classifyOwnerEvent({ event: { kind: 'owner_comment', payload: { command: 'amend', author: owner } }, line: line({ pause: { kind: 'ask' } }), owner }), null);
  assert.equal(classify('Use option A', line({ pause: { kind: 'ask' } }), 'someone-else'), null);
});

test('a body starting with a default external prefix is source external; any other owner body is source owner', () => {
  assert.deepEqual(DEFAULT_EXTERNAL_PREFIXES, ['Owner-delegated', 'Owner decision', 'Owner: additional acceptance', 'Superseded by']);
  const open = line({ status: 'working' });
  assert.equal(classify('Owner-delegated: pick the smaller scope', line({ pause: { kind: 'ask' } })).source, 'external');
  assert.equal(classify('Owner decision: approve', line({ pause: { kind: 'ask' } })).source, 'external');
  assert.equal(classify('Owner: additional acceptance: add a test', open).source, 'external');
  assert.equal(classify('Superseded by #500', line({ status: 'done' })).source, 'external');
  assert.equal(classify('Use option A', line({ pause: { kind: 'ask' } })).source, 'owner');
  assert.equal(classify('/rt pause').source, 'owner');
});

test('externalPrefixes can be overridden', () => {
  const event = comment('Custom: use B', owner);
  const entryOut = classifyOwnerEvent({ event, line: line({ pause: { kind: 'ask' } }), owner, externalPrefixes: ['Custom:'] });
  assert.equal(entryOut.source, 'external');
});

const T0 = Date.parse('2026-01-01T00:00:00Z');
const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'intervention-producers-'));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test('owner comments in a daemon cycle are recorded once; a second cycle over the same reader appends nothing', async () => {
  await withRoot(async (root) => {
    const reader = {
      listIssues: async () => [{ number: 7, title: 'Build it', updatedAt: '2026-01-01T00:00:02.000Z' }],
      listComments: async () => [
        { id: 'IC_1', body: '/rt pause', author: { login: owner }, createdAt: '2026-01-01T00:00:01.500Z' },
        { id: 'IC_2', body: 'Owner: additional acceptance: add a test', author: { login: owner }, createdAt: '2026-01-01T00:00:01.600Z' },
      ],
    };
    const ledger = openInterventions(root);
    const state = { status: 'working', pause: null };
    const cycle = () => cycleSteps({ root, inbox: openInbox(root), timers: openTimers(root), now: T0, reader,
      dispatchLine: async (batch) => {
        for (const event of batch.events) if (event.kind === 'owner_comment') recordOwnerEvent({ ledger, event, state, owner });
      } });
    await produceEvents({ inbox: openInbox(root), reader });
    await cycle();
    const file = join(root, '.roundtable', 'state', 'interventions.jsonl');
    const first = readFileSync(file, 'utf8');
    assert.equal(ledger.entries().entries.length, 2);
    const [pause, backlog] = ledger.entries().entries;
    assert.deepEqual([pause.category, pause.source, pause.kind, pause.ref], ['liveness', 'owner', 'pause', '#7']);
    assert.deepEqual([backlog.category, backlog.source, backlog.ref], ['backlog', 'external', '#7']);
    await cycle();
    await produceEvents({ inbox: openInbox(root), reader });
    await cycle();
    assert.equal(readFileSync(file, 'utf8'), first);
  });
});

test('recordOwnerEvent keys the entry by the comment source id, so recording it again appends nothing', async () => {
  await withRoot(async (root) => {
    const ledger = openInterventions(root);
    const event = { kind: 'owner_comment', issue: 7, source_event_id: 'gh-comment:IC_9', payload: { body: '/rt requeue', author: owner } };
    recordOwnerEvent({ ledger, event, state: { status: 'done', pause: null }, owner });
    recordOwnerEvent({ ledger, event, state: { status: 'done', pause: null }, owner });
    assert.equal(ledger.entries().entries.length, 1);
  });
});

const allowed = [
  ['restart-daemon', {}, [['restart']]],
  ['pause-queue', {}, [['pause', 'test']]],
  ['void-stale-pause', { ref: 'abc' }, [['requeue', 'abc']]],
  ['reprompt', { variantId: 'p1' }, [['apply', 'p1']]],
  ['rollback', { target: 'config' }, [['restore', 'config', 'v1']]],
  ['add-label', { number: 7 }, [['addLabel', 7, 'needs-owner']]],
  ['convert-to-draft', { number: 9 }, [['convertToDraft', 9]]],
];

const counter = () => { let n = 0; return () => `id-${++n}`; };
const req = (action, args = {}) => ({ action, reason: 'test', findingSignature: 'sig:1', args });

const CATEGORY = { 'restart-daemon': 'liveness', 'pause-queue': 'liveness', 'void-stale-pause': 'merge', 'add-label': 'merge', 'convert-to-draft': 'merge', reprompt: 'self-repair', rollback: 'self-repair' };

// A full actuator (as in setup) whose ledger and interventions are both recorded, so keys can be checked.
const withLedger = ({ restartFails = false, approved = ['p1'] } = {}) => {
  const entries = [];
  const appended = [];
  const ledger = createLedger({ append: (line) => entries.push(JSON.parse(line)), newId: counter(), now: () => 1 });
  const interventions = { append: (entry, { key }) => appended.push({ entry, key }) };
  const act = createActuator({
    ledger, now: () => 1000, notify: () => {}, interventions,
    daemon: { restart: async () => { if (restartFails) throw new Error('boom'); } },
    queue: { pause: () => {}, requeue: () => {} },
    github: { addLabel: async () => {}, convertToDraft: async () => {} },
    prompts: { isApproved: (v) => approved.includes(v), apply: async () => {} },
    releases: { lastKnownGood: () => 'v1', restore: async () => {} },
  }).act;
  return { act, entries, appended };
};

for (const [action, args] of allowed) {
  test(`${action} that ends done appends one external ${CATEGORY[action]} intervention keyed by its decision id`, async () => {
    const { act, entries, appended } = withLedger();
    const result = await act(req(action, args));
    assert.equal(result.status, 'done');
    assert.equal(appended.length, 1);
    assert.equal(appended[0].entry.category, CATEGORY[action]);
    assert.equal(appended[0].entry.source, 'external');
    assert.equal(appended[0].key, entries[0].id);
  });
}

test('rejected and failed actions append no intervention', async () => {
  const rejected = withLedger({ approved: [] });
  assert.equal((await rejected.act(req('reprompt', { variantId: 'p9' }))).status, 'rejected');
  const failed = withLedger({ restartFails: true });
  assert.equal((await failed.act(req('restart-daemon'))).status, 'failed');
  assert.equal(rejected.appended.length + failed.appended.length, 0);
});
