import test from 'node:test';
import assert from 'node:assert/strict';
import { createActuator, ALLOWED_ACTIONS, FORBIDDEN_ACTIONS } from '../../../runtime/supervisor/actuator.mjs';
import { createLedger } from '../../../runtime/supervisor/ledger.mjs';

const counter = () => { let n = 0; return () => `id-${++n}`; };

const setup = ({ restartOutcomes = [], approved = ['p1'], lastKnownGood = 'v1', config } = {}) => {
  const entries = [];
  const calls = [];
  const clock = { t: 1000 };
  const ledger = createLedger({ append: (line) => entries.push(JSON.parse(line)), newId: counter(), now: () => 1 });
  const actuator = createActuator({
    ledger,
    now: () => clock.t,
    notify: (msg) => calls.push(['notify', msg]),
    daemon: {
      restart: async () => {
        const outcome = restartOutcomes.shift();
        if (outcome === 'fail') throw new Error('boom');
        calls.push(['restart']);
      },
    },
    queue: { pause: (r) => calls.push(['pause', r]), requeue: (ref) => calls.push(['requeue', ref]) },
    github: {
      addLabel: (n, label) => calls.push(['addLabel', n, label]),
      convertToDraft: (n) => calls.push(['convertToDraft', n]),
    },
    prompts: { isApproved: (v) => approved.includes(v), apply: (v) => calls.push(['apply', v]) },
    releases: { lastKnownGood: () => lastKnownGood, restore: (t, v) => calls.push(['restore', t, v]) },
    config,
  });
  return { act: actuator.act, calls, entries, clock };
};

const req = (action, args = {}) => ({ action, reason: 'test', findingSignature: 'sig:1', args });

test('the allow-list and forbidden list are frozen and disjoint', () => {
  assert.equal(Object.isFrozen(ALLOWED_ACTIONS), true);
  assert.equal(Object.isFrozen(FORBIDDEN_ACTIONS), true);
  assert.equal(ALLOWED_ACTIONS.some((a) => FORBIDDEN_ACTIONS.includes(a)), false);
});

for (const action of ['merge', 'force-push', 'enable-jev', 'change-policy']) {
  test(`forbidden ${action} is rejected, not executed, and ledgered once`, async () => {
    const { act, calls, entries } = setup();
    const result = await act(req(action));
    assert.equal(result.status, 'rejected');
    assert.deepEqual(calls, []);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, action);
    assert.ok(entries[0].reason.startsWith('rejected: forbidden action'));
  });
}

test('an unknown action is rejected by default and ledgered once', async () => {
  const { act, calls, entries } = setup();
  const result = await act(req('deploy-everything'));
  assert.equal(result.status, 'rejected');
  assert.deepEqual(calls, []);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].reason.startsWith('rejected: not allow-listed'));
});

test('an invalid request without reason or findingSignature throws TypeError', async () => {
  const { act } = setup();
  await assert.rejects(act({ action: 'pause-queue', reason: '', findingSignature: 'x' }), TypeError);
  await assert.rejects(act({ action: 'pause-queue', reason: 'r' }), TypeError);
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

for (const [action, args, expectedCalls] of allowed) {
  test(`allow-listed ${action} writes a before and an after entry and calls once`, async () => {
    const { act, calls, entries } = setup();
    const result = await act(req(action, args));
    assert.equal(result.status, 'done');
    assert.deepEqual(calls, expectedCalls);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.map((e) => e.reason), ['before: test', 'after: ok']);
    assert.ok(entries.every((e) => e.action === action && e.mode === 'apply'));
  });
}

test('a failing action records an after entry saying failed', async () => {
  const { act, entries } = setup({ restartOutcomes: ['fail'] });
  const result = await act(req('restart-daemon'));
  assert.equal(result.status, 'failed');
  assert.equal(entries.length, 2);
  assert.equal(entries[1].reason, 'after: failed: boom');
});

test('three consecutive restart failures pause the queue and notify once; backoff rejects; success resets', async () => {
  const { act, calls, entries, clock } = setup({
    restartOutcomes: ['fail', 'fail', 'fail', 'ok', 'fail', 'fail'],
    config: { maxRestartFailures: 3, backoffBaseMs: 60000 },
  });
  await act(req('restart-daemon'));
  clock.t = 61000;
  await act(req('restart-daemon'));
  clock.t = 181000;
  await act(req('restart-daemon'));
  assert.equal(calls.filter(([c]) => c === 'pause').length, 1);
  assert.equal(calls.filter(([c]) => c === 'notify').length, 1);

  clock.t = 200000;
  const blocked = await act(req('restart-daemon'));
  assert.equal(blocked.status, 'rejected');
  assert.ok(entries.at(-1).reason.startsWith('after: rejected: backoff until'));
  assert.equal(calls.filter(([c]) => c === 'restart').length, 0);

  clock.t = 421000;
  assert.equal((await act(req('restart-daemon'))).status, 'done');
  clock.t = 481000;
  await act(req('restart-daemon'));
  assert.equal(calls.filter(([c]) => c === 'pause').length, 1);
});

test('rollback restores only to lastKnownGood, rejects null, and rejects other targets', async () => {
  const ok = setup();
  assert.equal((await ok.act(req('rollback', { target: 'prompt' }))).status, 'done');
  assert.deepEqual(ok.calls, [['restore', 'prompt', 'v1']]);

  const none = setup({ lastKnownGood: null });
  assert.equal((await none.act(req('rollback', { target: 'config' }))).status, 'rejected');
  assert.deepEqual(none.calls, []);

  const other = setup();
  assert.equal((await other.act(req('rollback', { target: 'daemon' }))).status, 'rejected');
  assert.deepEqual(other.calls, []);
});

test('reprompt with an unapproved variant is rejected and nothing is applied', async () => {
  const { act, calls, entries } = setup();
  const result = await act(req('reprompt', { variantId: 'evil' }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'rejected: prompt variant not approved');
  assert.deepEqual(calls, []);
  assert.equal(entries.length, 2);
});

test('add-label only ever sends needs-owner; other labels and bad numbers are rejected', async () => {
  const { act, calls } = setup();
  assert.equal((await act(req('add-label', { number: 5, label: 'bug' }))).status, 'rejected');
  assert.equal((await act(req('add-label', { number: 0 }))).status, 'rejected');
  assert.equal((await act(req('convert-to-draft', { number: 1.5 }))).status, 'rejected');
  assert.deepEqual(calls, []);
});

test('void-stale-pause rejects an empty ref', async () => {
  const { act, calls } = setup();
  assert.equal((await act(req('void-stale-pause', { ref: '' }))).status, 'rejected');
  assert.deepEqual(calls, []);
});
