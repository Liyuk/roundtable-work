import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_CATEGORIES, DECISIONS, IllegalTransitionError, decide, classifyPause, validPause, resumeFromPause, pickQueue,
} from '../../runtime/lib/machine.mjs';

const ready = { decision: 'done', pr: 42, ciGreen: true, reviewAccepted: true };

test('closed ask list and decision set are exactly the policy values (no merge category)', () => {
  assert.deepEqual([...ASK_CATEGORIES], ['scope', 'credentials', 'destructive', 'direction', 'production']);
  assert.deepEqual([...DECISIONS], ['continue', 'wait', 'ask', 'done', 'stop']);
  assert.equal(ASK_CATEGORIES.includes('merge'), false);
});

test('done is accepted only with PR, green CI and accepted review', () => {
  assert.deepEqual(decide(ready), { decision: 'done', pr: 42, ciGreen: true, reviewAccepted: true });
  for (const missing of [{ pr: null }, { ciGreen: false }, { reviewAccepted: false }]) {
    assert.throws(() => decide({ ...ready, ...missing }), IllegalTransitionError);
  }
});

test('ask accepts only categories on the closed list, and rejects merge', () => {
  assert.equal(decide({ decision: 'ask', category: 'scope', question: 'widen?' }).category, 'scope');
  for (const category of ['merge', 'deploy', '']) {
    assert.throws(() => decide({ decision: 'ask', category, question: 'q' }), (e) => e instanceof IllegalTransitionError && e.code === 'ILLEGAL_ASK_CATEGORY');
  }
});

test('wait needs an event binding and an unblock/retry timestamp', () => {
  const at = '2026-11-15T00:00:00Z';
  assert.deepEqual(decide({ decision: 'wait', event: 'ci:done', unblockAt: at }), { decision: 'wait', event: 'ci:done', unblockAt: at });
  assert.throws(() => decide({ decision: 'wait', unblockAt: at }), IllegalTransitionError);
  assert.throws(() => decide({ decision: 'wait', event: 'ci:done' }), IllegalTransitionError);
  assert.throws(() => decide({ decision: 'wait', event: 'ci:done', unblockAt: 'soon' }), IllegalTransitionError);
});

test('stop needs a budget or policy reason; continue is always accepted; unknown decisions are rejected', () => {
  assert.deepEqual(decide({ decision: 'stop', reason: 'budget' }), { decision: 'stop', reason: 'budget' });
  assert.throws(() => decide({ decision: 'stop', reason: 'bored' }), IllegalTransitionError);
  assert.deepEqual(decide({ decision: 'continue' }), { decision: 'continue' });
  assert.throws(() => decide({ decision: 'merge' }), IllegalTransitionError);
  assert.throws(() => decide(null), TypeError);
});

test('production is detected by label, body pattern, or diff path; otherwise continue', () => {
  assert.deepEqual(classifyPause({ labels: ['deploy'], body: '', diffPaths: [] }).category, 'production');
  assert.deepEqual(classifyPause({ labels: ['live'], body: '', diffPaths: [] }).decision, 'ask');
  assert.equal(classifyPause({ labels: ['bug'], body: 'deploy the thing', diffPaths: [] }).decision, 'continue');
  assert.equal(classifyPause({ labels: [], body: 'Rotate prod key', diffPaths: [] }, { bodyPatterns: ['\\bprod\\b'] }).category, 'production');
  assert.equal(classifyPause({ labels: [], body: 'Rotate prod key', diffPaths: [] }).decision, 'continue');
  assert.equal(classifyPause({ labels: [], body: '', diffPaths: ['live/app.yaml'] }, { diffPrefixes: ['live/'] }).decision, 'ask');
  assert.equal(classifyPause({ labels: [], body: '', diffPaths: ['src/a.mjs'] }, { diffPrefixes: ['live/'] }).decision, 'continue');
});

test('configured production labels replace the defaults', () => {
  const cfg = { productionLabels: ['prod-only'] };
  assert.equal(classifyPause({ labels: ['deploy'], body: '', diffPaths: [] }, cfg).decision, 'continue');
  assert.equal(classifyPause({ labels: ['prod-only'], body: '', diffPaths: [] }, cfg).decision, 'ask');
});

test('a pause with complete provenance matching the issue updatedAt is kept', () => {
  const pause = { runnerId: 'r1', runId: 'run-9', at: '2026-11-14T10:00:00Z', issueUpdatedAt: '2026-11-14T09:59:00Z', decision: 'ask' };
  const issue = { updatedAt: '2026-11-14T09:59:00Z' };
  assert.equal(validPause(pause, issue), pause);
  assert.equal(resumeFromPause(pause, issue), pause);
});

test('a stale pause (issue updated since) is void and the issue is re-queued to continue', () => {
  const pause = { runnerId: 'r1', runId: 'run-9', at: '2026-11-14T10:00:00Z', issueUpdatedAt: '2026-11-14T09:59:00Z', decision: 'ask' };
  const issue = { updatedAt: '2026-11-14T11:00:00Z' };
  assert.equal(validPause(pause, issue), null);
  assert.deepEqual(resumeFromPause(pause, issue), { decision: 'continue' });
});

test('a pause missing any provenance field is void', () => {
  const full = { runnerId: 'r1', runId: 'run-9', at: '2026-11-14T10:00:00Z', issueUpdatedAt: 'U', decision: 'blocked' };
  const issue = { updatedAt: 'U' };
  for (const field of ['runnerId', 'runId', 'at', 'issueUpdatedAt']) {
    const pause = { ...full, [field]: undefined };
    assert.equal(validPause(pause, issue), null, field);
    assert.deepEqual(resumeFromPause(pause, issue), { decision: 'continue' }, field);
  }
});

test('pickQueue never returns rt:proposed items, with or without rt:approved', () => {
  const issues = [
    { id: 1, labels: ['rt:proposed'] },
    { id: 2, labels: ['rt:proposed', 'rt:approved'] },
    { id: 3, labels: ['rt:approved'] },
    { id: 4, labels: [] },
  ];
  assert.deepEqual(pickQueue(issues).map((i) => i.id), [3, 4]);
});

test('the machine exposes no merge action', async () => {
  const mod = await import('../../runtime/lib/machine.mjs');
  assert.equal(Object.keys(mod).some((k) => /merge/i.test(k)), false);
});
