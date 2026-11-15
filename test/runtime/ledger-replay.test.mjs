import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore, ledgerEntry } from '../../runtime/lib/state.mjs';
import { tickClaims, CLAIM_MARKER } from '../../runtime/lib/claim.mjs';
import { createMergeEntryPoint } from '../../runtime/lib/merge.mjs';
import { projectLabels } from '../../runtime/lib/label-projection.mjs';
import { runGates, MAX_CI_RERUNS } from '../../runtime/lib/gates.mjs';
import { openOutbox, dispatch } from '../../runtime/lib/outbox.mjs';

const withTemp = async (fn) => {
  const root = await mkdtemp(join(tmpdir(), 'rt-ledger-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};

test('ledger appends are idempotent by entry id and read back through the same store', async () => {
  await withTemp(async (root) => {
    const store = await createStateStore({ workRoot: root, now: () => 7 });
    await store.append('12', { id: 'claim', type: 'claimed' });
    await store.append('12', { id: 'claim', type: 'claimed' });
    const state = await store.load('12');
    assert.equal(state.ledger.length, 1);
    assert.deepEqual(ledgerEntry(state, 'claim'), { id: 'claim', type: 'claimed', at: 7 });
    assert.equal(ledgerEntry(state, 'merge:abc'), null);
  });
});

test('a replayed claim tick after a lost marker writes one claim entry and one marker comment', async () => {
  await withTemp(async (root) => {
    const store = await createStateStore({ workRoot: root, now: () => 1 });
    const comments = [];
    const client = {
      addLabel: async () => {}, // the label write is lost in the simulated crash
      createComment: async (_n, body) => { comments.push(body); },
      listComments: async () => comments.map((body) => ({ body })),
    };
    const issue = { number: 234, labels: [] };
    const tick = () => tickClaims({ client, stateRoot: root, issues: [issue], store, loadState: (id) => store.load(id), isInFlight: async () => false, resume: async () => {} });
    await tick();
    await tick();
    assert.equal(comments.filter((body) => body.includes(CLAIM_MARKER)).length, 1);
    const state = await store.load('234');
    assert.equal(state.ledger.filter((e) => e.id === 'claim').length, 1);
    assert.equal(state.gateRecord, undefined, 'the claim is not kept in the gate record');
  });
});

test('a replayed merge for the same head does not squash again', async () => {
  await withTemp(async (root) => {
    const store = await createStateStore({ workRoot: root, now: () => 1 });
    const gateRecord = { issue: '53', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'ci'], safetyFiles: [], safetyApproved: false };
    const squashes = [];
    const entry = createMergeEntryPoint({
      store,
      gateState: { async get() { return gateRecord; } },
      github: {
        async getPullRequest() { return { state: 'open', draft: false, head: 'abc1234', mergeable: true, files: [] }; },
        async requiredGreen() { return true; },
        async squashMerge(pr) { squashes.push(pr); return 'merged'; },
      },
    });
    const evidence = { issue: '53', head: 'abc1234', tree: 'tree-a', highRisk: false, passed: ['gate0', 'gate1', 'ci'], ciGreen: true };
    await entry(90, evidence);
    assert.deepEqual(await entry(90, evidence), { replayed: true });
    assert.deepEqual(squashes, [90]);
    assert.equal(ledgerEntry(await store.load('53'), 'merge:abc1234').type, 'merged');
  });
});

test('CI re-run budget survives a crash inside the re-run: at most MAX_CI_RERUNS requests in total', async () => {
  await withTemp(async (root) => {
    const store = await createStateStore({ workRoot: root, now: () => 1 });
    const state = { get: async (id) => (await store.load(id)).gateRecord, put: (id, record) => store.update(id, (s) => { s.gateRecord = record; }) };
    let reruns = 0;
    const input = () => ({
      issue: '53', head: 'abc1234', tree: 'tree-a', changedFiles: ['README.md'], pr: 90, state, store,
      models: { reviewer: 'model-review' },
      gates: {
        async gate0() { return { passed: true }; },
        async reviewer() { return { passed: true, head: 'abc1234', rationale: 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.' }; },
      },
      ci: {
        async requiredGreen() { return { green: false, status: 'cancelled' }; },
        async rerunCancelled() { reruns += 1; throw new Error('provider crashed mid-request'); }, // simulated crash
      },
      merge: { async squash() { throw new Error('must not merge'); } },
      github: { async addLabel() {} },
    });
    let outcome;
    for (let run = 0; run < MAX_CI_RERUNS + 2; run++) {
      try { outcome = await runGates(input()); } catch { outcome = null; }
    }
    assert.equal(reruns, MAX_CI_RERUNS);
    assert.equal((await store.load('53')).ledger.filter((e) => e.type === 'ci_rerun').length, MAX_CI_RERUNS);
    assert.equal(outcome.status, 'blocked');
    assert.equal(outcome.hold, false, 'an exhausted budget fails closed');
  });
});

test('replaying the outbox after a crash before the receipt delivers each item once', async () => {
  await withTemp(async (root) => {
    const applied = new Set();
    const provider = { async deliver({ id }) { applied.add(id); return { ok: true }; } };
    const first = openOutbox(root);
    first.enqueue({ id: 'claim-comment:234', kind: 'comment', issue: 234, payload: { body: CLAIM_MARKER } });
    await provider.deliver({ id: 'claim-comment:234' }); // applied, then the process dies before markDelivered
    const replay = openOutbox(root);
    assert.equal(replay.enqueue({ id: 'claim-comment:234', kind: 'comment', issue: 234, payload: { body: CLAIM_MARKER } }), false);
    assert.equal(replay.pending().length, 1);
    assert.deepEqual((await dispatch({ outbox: replay, provider })).delivered, ['claim-comment:234']);
    assert.equal(applied.size, 1);
    assert.deepEqual(replay.pending(), []);
  });
});

test('claim, merge, CI re-run, and label projection all read and write the one state store', async () => {
  await withTemp(async (root) => {
    const store = await createStateStore({ workRoot: root, now: () => 1 });
    const touched = new Set();
    for (const name of ['load', 'append', 'update']) {
      const original = store[name];
      store[name] = (...args) => { touched.add(`${name}:${args[0]}`); return original(...args); };
    }
    // Claim writes the ledger; the projection reads that same state and corrects the label.
    const comments = [];
    const client = { addLabel: async () => {}, removeLabel: async () => {}, createComment: async (_n, body) => comments.push(body), listComments: async () => comments.map((body) => ({ body })) };
    await tickClaims({ client, stateRoot: root, issues: [{ number: 53, labels: [] }], store, loadState: (id) => store.load(id), isInFlight: async () => false, resume: async () => {} });
    assert.ok(ledgerEntry(await store.load('53'), 'claim'), 'claim is visible through the store');
    assert.equal((await projectLabels({ number: 53, issue: { state: 'open', labels: [] }, client, store, now: () => 2 })).desired.length, 1);
    // Merge reads the ledger through the same store and records the merge there.
    const gateRecord = { issue: '53', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'ci'], safetyFiles: [], safetyApproved: false };
    const entry = createMergeEntryPoint({ store, gateState: { async get() { return gateRecord; } }, github: {
      async getPullRequest() { return { state: 'open', draft: false, head: 'abc1234', mergeable: true, files: [] }; },
      async requiredGreen() { return true; },
      async squashMerge() { return 'merged'; },
    } });
    await entry(90, { issue: '53', head: 'abc1234', tree: 'tree-a', highRisk: false, passed: ['gate0', 'gate1', 'ci'], ciGreen: true });
    assert.equal(ledgerEntry(await store.load('53'), 'merge:abc1234').type, 'merged');
    // A CI re-run is recorded in the ledger of the same store.
    const gates = { gate0: async () => true, reviewer: async () => ({ passed: true, head: 'abc1234', rationale: 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.' }) };
    await runGates({ issue: '53', head: 'abc1234', tree: 'tree-a', changedFiles: ['README.md'], pr: 90, store, models: { reviewer: 'model-review' },
      state: { get: async (id) => (await store.load(id)).gateRecord, put: (id, record) => store.update(id, (s) => { s.gateRecord = record; }) },
      gates, ci: { requiredGreen: async () => ({ green: false, status: 'cancelled' }), rerunCancelled: async () => {} },
      merge: { squash: async () => { throw new Error('must not merge'); } }, github: { addLabel: async () => {} } });
    assert.equal((await store.load('53')).ledger.filter((e) => e.type === 'ci_rerun').length, 1);
    // Every reader and writer above went through this one instance: a fresh reader sees the same ledger.
    const fresh = await createStateStore({ workRoot: root, now: () => 1 });
    assert.deepEqual((await fresh.load('53')).ledger, (await store.load('53')).ledger);
    assert.ok([...touched].some((t) => t.startsWith('append:53')) && [...touched].some((t) => t.startsWith('load:53')));
  });
});
