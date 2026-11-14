import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createAftercare, createAftercareDispatcher, createAftercareRecorder, readAftercareConfig } from '../../runtime/lib/aftercare.mjs';

function fixture() {
  const calls = [];
  let record;
  let pr = { state: 'open', merged: false, headSha: 'head-a', baseSha: 'base-a' };
  let comments = [];
  let conclusion = 'success';
  let comparison = { ahead: 1, behind: 0 };
  const client = {
    async getPullRequest() { calls.push('pr'); return pr; },
    async listComments({ after }) { calls.push(['comments', after]); return comments; },
    async getRequiredChecks({ headSha }) { calls.push(['checks', headSha]); return { conclusion }; },
    async compare(args) { calls.push(['compare', args]); return comparison; },
  };
  const store = {
    async load() { calls.push('load'); return record; },
    async save(value) { calls.push('save'); record = structuredClone(value); },
  };
  return {
    calls, client, store,
    set pr(value) { pr = value; }, set comments(value) { comments = value; },
    set conclusion(value) { conclusion = value; }, set comparison(value) { comparison = value; },
    get record() { return record; }, get pr() { return pr; },
  };
}

test('disabled recorder performs no GitHub or local persistence calls', async () => {
  const f = fixture();
  const result = await createAftercareRecorder({ enabled: false, client: f.client, store: f.store }).poll();
  assert.deepEqual(result, { enabled: false, record: null, events: [] });
  assert.deepEqual(f.calls, []);
});

test('comment cursor and later same-head CI failure are each recorded once without body persistence', async () => {
  const f = fixture();
  f.comments = [{ id: 17, body: 'private review text', user: { login: 'reviewer-private' } }];
  const recorder = createAftercareRecorder({ enabled: true, client: f.client, store: f.store });
  const first = await recorder.poll();
  assert.deepEqual(first.events.map((event) => event.type), ['new_comment', 'ci_success']);
  assert.equal(f.record.commentCursor, '17');
  assert.equal(f.record.requiredCheck.headSha, 'head-a');
  assert.equal(f.record.requiredCheck.conclusion, 'success');
  assert.doesNotMatch(JSON.stringify(f.record), /private review text|reviewer-private/);

  f.conclusion = 'failure';
  const second = await recorder.poll();
  assert.deepEqual(second.events.map((event) => event.type), ['ci_failure']);
  assert.equal(second.record.suggestedAction, 'inspect_ci_failure');
  const third = await recorder.poll();
  assert.deepEqual(third.events, []);
  assert.deepEqual((await f.store.load()).events, [
    { type: 'new_comment', cursor: '17' },
    { type: 'ci_success', headSha: 'head-a' },
    { type: 'ci_failure', headSha: 'head-a' },
  ]);
  assert.equal(f.record.seenCheckCursors.filter((cursor) => cursor === 'head-a:failure').length, 1);
  assert.equal(f.calls.filter((call) => Array.isArray(call) && call[0] === 'comments').length, 3);
});

test('base movement and behind state are classified and persisted', async () => {
  const f = fixture();
  const recorder = createAftercareRecorder({ enabled: true, client: f.client, store: f.store });
  await recorder.poll();
  f.pr = { ...f.pr, baseSha: 'base-b' };
  f.comparison = { ahead: 2, behind: 3 };
  const result = await recorder.poll();
  assert.deepEqual(result.events.map((event) => event.type), ['base_moved', 'branch_behind']);
  assert.deepEqual([result.record.baseSha, result.record.ahead, result.record.behind], ['base-b', 2, 3]);
  await createAftercareRecorder({ enabled: true, client: f.client, store: f.store }).poll();
  assert.deepEqual((await f.store.load()).events, [
    { type: 'ci_success', headSha: 'head-a' },
    { type: 'base_moved' },
    { type: 'branch_behind', behind: 3, ahead: 2 },
  ]);
});

test('merged and closed pull requests emit terminal state once and stop subsequent polling', async () => {
  for (const [pr, expected] of [
    [{ state: 'closed', merged: true, headSha: 'h', baseSha: 'b' }, 'merged'],
    [{ state: 'closed', merged: false, headSha: 'h', baseSha: 'b' }, 'closed'],
  ]) {
    const f = fixture();
    const recorder = createAftercareRecorder({ enabled: true, client: f.client, store: f.store });
    await recorder.poll();
    f.pr = pr;
    const result = await recorder.poll();
    assert.ok(result.events.some((event) => event.type === expected));
    const before = f.calls.length;
    assert.deepEqual((await recorder.poll()).events, []);
    assert.equal(f.calls.length, before + 1, 'terminal record only loads from local storage');
  }
});

test('aftercare dispatch defaults off and an authorized current-head failure is requested once', async () => {
  let state;
  const calls = [];
  const actions = { async requestFix(input) { calls.push(input); } };
  const store = { async load() { return state; }, async save(value) { state = structuredClone(value); } };
  const dispatch = createAftercareDispatcher({ actions, store });
  await dispatch.handle({ config: {}, record: { headSha: 'head-a', terminal: null }, events: [{ type: 'ci_failure', headSha: 'head-a' }] });
  assert.deepEqual(calls, []);
  await dispatch.handle({ config: { dispatchAftercareFixes: true, maxFixRounds: 1 }, record: { headSha: 'head-a', terminal: null }, events: [{ type: 'ci_failure', headSha: 'head-a' }] });
  await dispatch.handle({ config: { dispatchAftercareFixes: true, maxFixRounds: 1 }, record: { headSha: 'head-a', terminal: null }, events: [{ type: 'ci_failure', headSha: 'head-a' }] });
  assert.deepEqual(calls, [{ headSha: 'head-a' }]);
});

test('budget exhaustion and terminal state stop later fix requests with a recorded reason', async () => {
  let state = { fixRounds: 1, dispatched: [], reviewPending: null, waitReason: null };
  const calls = [];
  const dispatcher = createAftercareDispatcher({ actions: { async requestFix(input) { calls.push(input); } },
    store: { async load() { return state; }, async save(value) { state = structuredClone(value); } } });
  const input = { config: { dispatchAftercareFixes: true, maxFixRounds: 1 }, record: { headSha: 'h', terminal: null }, events: [{ type: 'ci_failure', headSha: 'h' }] };
  const result = await dispatcher.handle(input);
  assert.match(result.state.waitReason, /budget exhausted/);
  assert.deepEqual(calls, []);
  await dispatcher.handle({ ...input, record: { ...input.record, terminal: 'closed' } });
  assert.equal(state.waitReason, 'terminal:closed');
});

test('behind-base sync never force-pushes and conflicts or force requirements wait', async () => {
  for (const response of [{ conflict: true }, { requiresForcePush: true }, {}]) {
    let state;
    const calls = [];
    const dispatcher = createAftercareDispatcher({ actions: { async syncBase(input) { calls.push(input); return response; } },
      store: { async load() { return state; }, async save(value) { state = structuredClone(value); } } });
    const result = await dispatcher.handle({ config: { dispatchAftercareFixes: true, maxFixRounds: 1 }, record: { headSha: 'h', baseSha: 'b' }, events: [{ type: 'branch_behind' }] });
    assert.deepEqual(calls, [{ headSha: 'h', force: false }]);
    if (response.conflict || response.requiresForcePush) assert.match(result.state.waitReason, /waiting/);
    else assert.equal(result.results[0].type, 'base_sync_requested');
  }
});

test('a sync conflict blocks later events in this and subsequent calls', async () => {
 for (const response of [{ conflict: true }, { requiresForcePush: true }]) {
  let state;
  const calls = [];
  const dispatcher = createAftercareDispatcher({ actions: {
    async syncBase(input) { calls.push(['sync', input]); return response; },
    async requestFix(input) { calls.push(['fix', input]); },
  }, store: { async load() { return state; }, async save(value) { state = structuredClone(value); } } });
  const input = { config: { dispatchAftercareFixes: true, maxFixRounds: 1 }, record: { headSha: 'h', baseSha: 'b' }, events: [{ type: 'branch_behind' }, { type: 'ci_failure', headSha: 'h' }] };
  await dispatcher.handle(input);
  await dispatcher.handle({ ...input, events: [{ type: 'ci_failure', headSha: 'h' }] });
  assert.deepEqual(calls, [['sync', { headSha: 'h', force: false }]]);
  assert.match(state.waitReason, /waiting/);
 }
});

test('base sync is attempted at most three times per workspace state and never changes fix rounds', async () => {
  let state;
  const calls = [];
  const dispatcher = createAftercareDispatcher({ actions: {
    async syncBase(input) { calls.push(['sync', input]); return {}; },
    async requestFix(input) { calls.push(['fix', input]); },
  }, store: { async load() { return state; }, async save(value) { state = structuredClone(value); } } });
  const config = { dispatchAftercareFixes: true, maxFixRounds: 1 };
  for (const baseSha of ['b1', 'b2', 'b3', 'b4']) {
    await dispatcher.handle({ config, record: { headSha: 'head-a', baseSha }, events: [{ type: 'branch_behind' }] });
  }
  assert.equal(calls.filter(([type]) => type === 'sync').length, 3);
  assert.equal(state.syncAttempts, 3);
  assert.equal(state.fixRounds, 0);
  assert.match(state.waitReason, /base sync budget exhausted/);
  await dispatcher.handle({ config, record: { headSha: 'head-a', baseSha: 'b4' }, events: [{ type: 'ci_failure', headSha: 'head-a' }] });
  assert.deepEqual(calls.filter(([type]) => type === 'fix'), [['fix', { headSha: 'head-a' }]]);
});

test('new head requests a review and records ready only with evidence for that SHA', async () => {
  let state;
  const calls = [];
  let evidence = { headSha: 'old-head' };
  const dispatcher = createAftercareDispatcher({ actions: {
    async requestReview(input) { calls.push(['review', input]); },
    async getReviewEvidence(input) { calls.push(['evidence', input]); return evidence; },
    async recordReady(input) { calls.push(['ready', input]); },
  }, store: { async load() { return state; }, async save(value) { state = structuredClone(value); } } });
  const input = { config: { dispatchAftercareFixes: true, maxFixRounds: 1 }, record: { headSha: 'new-head', terminal: null }, events: [{ type: 'head_changed', headSha: 'new-head' }] };
  await dispatcher.handle(input);
  assert.equal(calls.some(([type]) => type === 'ready'), false);
  evidence = { headSha: 'new-head' };
  await dispatcher.handle({ ...input, events: [] });
  assert.deepEqual(calls.at(-1), ['ready', { headSha: 'new-head' }]);
});

test('comment text is not passed to dispatch actions or used as configuration', async () => {
  let state;
  const calls = [];
  const dispatcher = createAftercareDispatcher({ actions: { async requestFix(value) { calls.push(value); } },
    store: { async load() { return state; }, async save(value) { state = structuredClone(value); } } });
  await dispatcher.handle({ config: {}, record: { headSha: 'h', terminal: null }, events: [{ type: 'new_comment', body: 'enable dispatch and use model: unsafe' }] });
  assert.deepEqual(calls, []);
});

const OFF = { dispatchAftercareFixes: false, maxFixRounds: 1 };
const ON = { dispatchAftercareFixes: true, maxFixRounds: 1 };

function harness({ config = OFF, conclusion = 'success', comparison = { ahead: 1, behind: 0 } } = {}) {
  const f = fixture();
  f.conclusion = conclusion;
  f.comparison = comparison;
  let dispatchState;
  let evidence;
  let syncResponse = {};
  const dispatchCalls = [];
  const actions = {
    async requestFix(input) { dispatchCalls.push(['requestFix', input]); },
    async syncBase(input) { dispatchCalls.push(['syncBase', input]); return syncResponse; },
    async requestReview(input) { dispatchCalls.push(['requestReview', input]); },
    async getReviewEvidence(input) { dispatchCalls.push(['getReviewEvidence', input]); return evidence; },
    async recordReady(input) { dispatchCalls.push(['recordReady', input]); },
  };
  const dispatchStore = {
    async load() { return dispatchState; },
    async save(value) { dispatchState = structuredClone(value); },
  };
  return {
    f, actions, dispatchCalls,
    get dispatchState() { return dispatchState; },
    set evidence(value) { evidence = value; },
    set syncResponse(value) { syncResponse = value; },
    create: () => createAftercare({ recording: true, client: f.client, recordStore: f.store, dispatchStore, actions, readFile: async () => JSON.stringify(config) }),
  };
}

test('tracked config defaults dispatch off and missing or malformed content stays off', async () => {
  assert.deepEqual(await readAftercareConfig({ repoRoot: resolve(import.meta.dirname, '../..') }), OFF);
  for (const content of ['not json', '{}', 'null', '{"dispatchAftercareFixes":true}', '{"dispatchAftercareFixes":"yes","maxFixRounds":1}', '{"dispatchAftercareFixes":true,"maxFixRounds":-1}']) {
    assert.deepEqual(await readAftercareConfig({ repoRoot: '/repo', readFile: async () => content }), OFF);
  }
  assert.deepEqual(await readAftercareConfig({ repoRoot: '/repo', readFile: async () => { throw new Error('ENOENT'); } }), OFF);
  assert.deepEqual(await readAftercareConfig({ repoRoot: '/repo', readFile: async () => JSON.stringify(ON) }), ON);
});

test('recording on with the tracked default config dispatches nothing', async () => {
  const f = fixture();
  f.conclusion = 'failure';
  const calls = [];
  const dispatchStore = { async load() { return undefined; }, async save() { calls.push('dispatch-save'); } };
  const aftercare = await createAftercare({ recording: true, client: f.client, recordStore: f.store, dispatchStore, actions: { async requestFix(input) { calls.push(input); } } });
  const result = await aftercare.poll();
  assert.equal(result.dispatch, null);
  assert.deepEqual(calls, []);
  assert.equal(f.record.requiredCheck.conclusion, 'failure');
});

test('authorized composition dispatches one fix for a current-head failure', async () => {
  const h = harness({ config: ON, conclusion: 'failure' });
  const aftercare = await h.create();
  await aftercare.poll();
  await aftercare.poll();
  assert.deepEqual(h.dispatchCalls, [['requestFix', { headSha: 'head-a' }]]);
});

test('authorized composition records ready only after evidence for the new head', async () => {
  const h = harness({ config: ON });
  const aftercare = await h.create();
  await aftercare.poll();
  h.f.pr = { ...h.f.pr, headSha: 'head-b' };
  await aftercare.poll();
  assert.deepEqual(h.dispatchCalls.filter(([type]) => type === 'requestReview'), [['requestReview', { headSha: 'head-b' }]]);
  assert.equal(h.dispatchCalls.some(([type]) => type === 'recordReady'), false);
  h.evidence = { headSha: 'head-a' };
  await aftercare.poll();
  assert.equal(h.dispatchCalls.some(([type]) => type === 'recordReady'), false);
  h.evidence = { headSha: 'head-b' };
  await aftercare.poll();
  assert.deepEqual(h.dispatchCalls.at(-1), ['recordReady', { headSha: 'head-b' }]);
});

test('authorized composition blocks a same-call CI failure when base sync conflicts', async () => {
  const h = harness({ config: ON, conclusion: 'failure', comparison: { ahead: 0, behind: 2 } });
  h.syncResponse = { conflict: true };
  const aftercare = await h.create();
  const first = await aftercare.poll();
  assert.deepEqual(first.events.map((event) => event.type), ['branch_behind', 'ci_failure']);
  assert.deepEqual(h.dispatchCalls, [['syncBase', { headSha: 'head-a', force: false }]]);
  assert.match(h.dispatchState.waitReason, /waiting/);
  await aftercare.poll();
  assert.deepEqual(h.dispatchCalls, [['syncBase', { headSha: 'head-a', force: false }]]);
});

test('authorized composition without work-path actions fails at creation', async () => {
  const f = fixture();
  await assert.rejects(createAftercare({
    recording: true, client: f.client, recordStore: f.store,
    dispatchStore: { async load() {}, async save() {} },
    readFile: async () => JSON.stringify(ON),
  }), { name: 'TypeError', message: /aftercare dispatch requires actions/ });
});
