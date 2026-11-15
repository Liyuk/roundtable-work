import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateStore, freshState } from '../../runtime/lib/state.mjs';
import { deriveLabelState, projectLabels, MANAGED_LABELS } from '../../runtime/lib/label-projection.mjs';

const open = (labels) => ({ issue: { state: 'open', labels }, state: null });

function fakeClient() {
  const calls = [];
  return { calls, addLabel: async (number, label) => calls.push(['addLabel', number, label]), removeLabel: async (number, label) => calls.push(['removeLabel', number, label]) };
}

test('managed labels are the four rt labels the projection may write', () => {
  assert.deepEqual(MANAGED_LABELS, ['rt:running', 'rt:ready-to-merge', 'rt:ask', 'rt:blocked']);
});

test('derivation is pure: same input gives same output and the input is not mutated', () => {
  const observations = { issue: { state: 'open', labels: ['rt:running', 'type:bug'] }, state: { ...freshState('234'), status: 'working' } };
  const before = structuredClone(observations);
  const first = deriveLabelState(observations);
  assert.deepEqual(deriveLabelState(observations), first);
  assert.deepEqual(first, ['rt:running']);
  assert.deepEqual(observations, before);
});

test('derivation follows the precedence rules', () => {
  const state = (patch) => ({ ...freshState('234'), ...patch });
  const gates = { passed: ['gate0', 'gate1', 'gate2'] };
  assert.deepEqual(deriveLabelState({ issue: { state: 'closed', labels: [] }, state: state({ status: 'working' }) }), []);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ pause: { kind: 'ask', category: 'x' }, status: 'working' }) }), ['rt:ask']);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ pause: { kind: 'out-of-scope', category: 'x' }, gateRecord: gates }) }), ['rt:blocked']);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ gateRecord: gates, status: 'working' }) }), ['rt:ready-to-merge']);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ status: 'queued' }) }), ['rt:running']);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ status: 'done' }) }), []);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: null }), []);
});

test('one projection call corrects blocked + ready-to-merge to the derived state and logs the event', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-label-'));
  try {
    const store = await createStateStore({ workRoot: root, now: () => 5000 });
    await store.update('234', (s) => { s.pause = { kind: 'blocked', category: 'gate' }; s.gateRecord = { passed: ['gate0', 'gate1', 'gate2'] }; });
    const client = fakeClient();
    const issue = { state: 'open', labels: ['rt:blocked', 'rt:ready-to-merge', 'type:bug'] };
    const result = await projectLabels({ number: 234, issue, client, store, now: () => 6000 });
    assert.deepEqual(client.calls, [['removeLabel', 234, 'rt:ready-to-merge']]);
    assert.deepEqual(result, { corrected: true, added: [], removed: ['rt:ready-to-merge'], desired: ['rt:blocked'] });
    const logged = await store.load('234');
    assert.equal(logged.lastEvent.type, 'label_corrected');
    assert.deepEqual(logged.lastEvent.detail, { added: [], removed: ['rt:ready-to-merge'] });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('projection reads the state from the same store it writes to, so a later write is seen without a second copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-label-'));
  try {
    const store = await createStateStore({ workRoot: root, now: () => 5000 });
    const client = fakeClient();
    const issue = { state: 'open', labels: ['rt:running'] };
    assert.equal((await projectLabels({ number: 9, issue, client, store, now: () => 1 })).corrected, false);
    await store.update('9', (s) => { s.status = 'done'; });
    const result = await projectLabels({ number: 9, issue, client, store, now: () => 2 });
    assert.deepEqual(result, { corrected: true, added: [], removed: ['rt:running'], desired: [] });
    assert.deepEqual(client.calls, [['removeLabel', 9, 'rt:running']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('projection writes only managed label add/remove and nothing when labels already match', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-label-'));
  try {
    const store = await createStateStore({ workRoot: root, now: () => 5000 });
    await store.update('7', (s) => { s.status = 'working'; });
    const client = fakeClient();
    const added = await projectLabels({ number: 7, issue: { state: 'open', labels: ['type:bug'] }, client, store, now: () => 1 });
    assert.deepEqual(client.calls, [['addLabel', 7, 'rt:running']]);
    assert.deepEqual(added, { corrected: true, added: ['rt:running'], removed: [], desired: ['rt:running'] });

    const none = fakeClient();
    const noop = await projectLabels({ number: 7, issue: { state: 'open', labels: ['rt:running', 'priority:high'] }, client: none, store, now: () => 1 });
    assert.deepEqual(none.calls, []);
    assert.deepEqual(noop, { corrected: false, added: [], removed: [], desired: ['rt:running'] });
    assert.equal((await store.load('7')).lastEvent.type, 'label_corrected', 'no new event when nothing changed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('low-risk issues with gate0 and gate1 passed are ready-to-merge without gate2', () => {
  const state = (patch) => ({ ...freshState('234'), ...patch });
  const gates = { passed: ['gate0', 'gate1'] };
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ gateRecord: gates, status: 'done' }) }), ['rt:ready-to-merge']);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ gateRecord: gates, status: 'done' }), highRisk: false }), ['rt:ready-to-merge']);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ gateRecord: gates, status: 'working' }), highRisk: true }), ['rt:running']);
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: [] }, state: state({ gateRecord: { passed: ['gate0', 'gate1', 'gate2'] }, status: 'done' }), highRisk: true }), ['rt:ready-to-merge']);
});

test('a blocked label outranks a stale ready-to-merge label and the issue is not claimed as ready', () => {
  const state = { status: 'done', gateRecord: { passed: ['gate0', 'gate1'] } };
  assert.deepEqual(deriveLabelState({ issue: { state: 'open', labels: ['rt:blocked', 'rt:ready-to-merge'] }, state }), ['rt:blocked']);
});
