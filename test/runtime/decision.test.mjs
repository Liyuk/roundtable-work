import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyDecision, ASK_CATEGORIES, routeModel, MODEL_ROUTING, resumeOnOwnerReply, releaseParentWhenChildrenClose } from '../../runtime/lib/decision.mjs';

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-decision-'));
  const events = [];
  const client = {
    addLabel: async (id, label) => events.push(['label+', id, label]),
    removeLabel: async (id, label) => events.push(['label-', id, label]),
    createComment: async (id, body) => events.push(['comment', id, body]),
    createIssue: async (input) => { events.push(['issue', input]); return { number: events.length + 100 }; },
  };
  return { root, client, events };
};

test('ask categories are closed and outcomes use only injected client effects', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(ASK_CATEGORIES, ['scope', 'credentials', 'destructive', 'direction']);
    const r = await applyDecision({ decision: { outcome: 'ask', category: 'credentials', reason: 'Need access' }, issue: { number: 9 }, client: f.client, state: {} });
    assert.equal(r.status, 'waiting_person');
    assert.deepEqual(f.events.map(e => e.slice(0, 3)), [['comment', 9, 'Decision needed (credentials): Need access'], ['label+', 9, 'rt:ask']]);
    await assert.rejects(applyDecision({ decision: { outcome: 'ask', category: 'merge' }, issue: { number: 9 }, client: f.client, state: {} }), /category/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('out-of-scope blocks without closing; decompose creates rt:self children and holds parent', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.root, 'drafts'));
    await writeFile(join(f.root, 'drafts', 'child.json'), JSON.stringify({ title: 'Child', body: 'work' }));
    const r = await applyDecision({ decision: { outcome: 'decompose', drafts: ['drafts/child.json'] }, issue: { number: 10 }, client: f.client, state: {}, worktreeRoot: f.root });
    assert.equal(r.status, 'decomposed');
    assert.deepEqual(f.events.filter(e => e[0] === 'label+').map(e => e[2]), ['rt:self', 'rt:hold']);
    f.events.length = 0;
    await applyDecision({ decision: { outcome: 'out-of-scope', reason: 'outside ticket' }, issue: { number: 10 }, client: f.client, state: {} });
    assert.deepEqual(f.events.map(e => e.slice(0, 3)), [['comment', 10, 'Out of scope: outside ticket'], ['label+', 10, 'rt:blocked']]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('continue persists resumable state and clears stale pause labels', async () => {
  const f = await fixture();
  try {
    const state = {};
    const r = await applyDecision({ decision: { outcome: 'do' }, issue: { number: 11 }, client: f.client, state });
    assert.equal(r.status, 'queued');
    assert.equal(state.nextTurn, true);
    assert.deepEqual(f.events.map(e => e.slice(0, 3)), [['label-', 11, 'rt:ask'], ['label-', 11, 'rt:blocked']]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('disputed ask escalates before owner interruption and observes decision budget', async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const decision = { outcome: 'ask', category: 'direction', reason: 'uncertain' };
    const result = await applyDecision({ decision, issue: { number: 12 }, client: f.client, state: { attempts: { decisions: 0 } }, maxDecisions: 1, escalate: async () => { calls++; return { outcome: 'ask', category: 'direction', reason: 'still uncertain' }; } });
    assert.equal(calls, 1);
    assert.equal(result.status, 'waiting_person');
    await applyDecision({ decision, issue: { number: 12 }, client: f.client, state: { attempts: { decisions: 1 } }, maxDecisions: 1, escalate: async () => { calls++; } });
    assert.equal(calls, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('a disputed ask waits durably when escalation is not available or fails', async () => {
  const f = await fixture();
  try {
    const decision = { outcome: 'ask', category: 'scope', reason: 'uncertain' };
    const state = { attempts: { decisions: 0 } };
    const result = await applyDecision({ decision, issue: { number: 13 }, client: f.client, state });
    assert.equal(result.status, 'waiting_external');
    assert.equal(state.pendingDecision.category, 'scope');
    assert.equal(f.events.length, 0);
    const failed = await applyDecision({ decision, issue: { number: 14 }, client: f.client, state: { attempts: { decisions: 0 } }, escalate: async () => { throw new Error('runner unavailable'); } });
    assert.equal(failed.reason, 'escalation_failed');
    assert.equal(f.events.length, 0);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('work type routing is explicit, valid, and has no prohibited model entries', () => {
  assert.equal(routeModel('chief'), MODEL_ROUTING.chief);
  assert.equal(routeModel('crosscheck'), 'gpt-6.1-terra');
  assert.throws(() => routeModel('unknown'), /work type/);
  assert.ok(Object.values(MODEL_ROUTING).every(m => typeof m === 'string' && m.length > 0));
  assert.throws(() => routeModel('chief', { chief: 'unconfigured/model-x' }), /Invalid model routing/);
});

test('owner reply resumes a pause and clears its provenance only for a new author comment', async () => {
  const f = await fixture();
  try {
    const state = { status: 'waiting_person', pauseCommentCount: 1, pauseReason: { category: 'scope' } };
    const issue = { number: 17, author: { login: 'owner' } };
    f.client.listComments = async () => [{ user: { login: 'agent' } }, { user: { login: 'owner' } }];
    assert.equal(await resumeOnOwnerReply({ state, issue, client: f.client }), true);
    assert.equal(state.status, 'queued');
    assert.equal(state.pauseReason, null);
    assert.deepEqual(f.events.map(e => e[2]), ['rt:ask', 'rt:blocked']);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('held parent remains paused until every child closes', async () => {
  const f = await fixture();
  try {
    const state = { childIssues: [101, 102], status: 'waiting_external' };
    const states = new Map([[101, { state: 'CLOSED' }], [102, { state: 'OPEN' }]]);
    assert.equal(await releaseParentWhenChildrenClose({ state, getIssue: async id => states.get(id), client: f.client, parentNumber: 17 }), false);
    states.set(102, { state: 'CLOSED' });
    assert.equal(await releaseParentWhenChildrenClose({ state, getIssue: async id => states.get(id), client: f.client, parentNumber: 17 }), true);
    assert.equal(state.nextTurn, true);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
