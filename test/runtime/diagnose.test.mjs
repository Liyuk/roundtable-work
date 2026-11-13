import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStalls } from '../../runtime/lib/stall.mjs';
import { CLASS_ROUTES, classifyStall, createMemory, diagnose, DIAGNOSER, recallAction, recordOutcome } from '../../runtime/lib/diagnose.mjs';

const MIN = 60000;
const stallOf = (events, now) => detectStalls({ events, now })[0];
const cancelled = stallOf([{ type: 'progress', at: 1 }, { type: 'ci', at: 2, required: [{ name: 'test', status: 'cancelled' }] }], 3);
const idle = stallOf([{ type: 'progress', at: 0 }], 91 * MIN);

const card = (extra = {}) => ({ stage: 'implement', class: 'code', evidence: ['assertion failed in test A'], ...extra });
function fakeProvider(...replies) {
  const provider = {
    calls: 0,
    async call() {
      const reply = replies[Math.min(provider.calls, replies.length - 1)];
      provider.calls += 1;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return provider;
}

test('the diagnoser is read-only at the decider tier', () => {
  assert.deepEqual({ ...DIAGNOSER }, { role: 'diagnoser', readOnly: true, tier: 'decider' });
});

test('a cancelled-only CI stall is infra, routed to rerun, without calling the provider', async () => {
  const provider = fakeProvider(card());
  const result = await diagnose({ stall: cancelled, provider, memory: createMemory() });
  assert.equal(classifyStall(cancelled), 'infra');
  assert.deepEqual({ class: result.class, action: result.action, delegate: result.delegate }, { class: 'infra', action: 'rerun', delegate: null });
  assert.equal(provider.calls, 0);
});

test('infra and rule-conflict never delegate to the fixer', () => {
  assert.equal(CLASS_ROUTES.infra.delegate, null);
  assert.equal(CLASS_ROUTES['rule-conflict'].delegate, null);
  assert.equal(CLASS_ROUTES.code.delegate, 'fixer');
  assert.equal(CLASS_ROUTES['unclear-spec'].action, 'clarify');
});

for (const [name, bad] of [['missing class', card({ class: undefined })], ['unknown class', card({ class: 'vibes' })]]) {
  test(`a ${name} card is re-asked exactly once then fails closed`, async () => {
    const provider = fakeProvider(bad, bad);
    const result = await diagnose({ stall: idle, provider, memory: createMemory() });
    assert.equal(provider.calls, 2);
    assert.deepEqual({ class: result.class, action: result.action, delegate: result.delegate, source: result.source },
      { class: 'unclear-spec', action: 'clarify', delegate: null, source: 'fail-closed' });
  });
}

test('a valid card on the re-ask is accepted', async () => {
  const provider = fakeProvider(card({ class: 'vibes' }), card());
  const result = await diagnose({ stall: idle, provider, memory: createMemory() });
  assert.equal(provider.calls, 2);
  assert.deepEqual([result.class, result.action, result.delegate], ['code', 'fixer', 'fixer']);
});

test('a provider that throws or sends extra fields fails closed', async () => {
  const thrown = await diagnose({ stall: idle, provider: fakeProvider(new Error('down')), memory: createMemory() });
  const extra = await diagnose({ stall: idle, provider: fakeProvider(card({ notes: 'x' })), memory: createMemory() });
  assert.equal(thrown.source, 'fail-closed');
  assert.equal(extra.source, 'fail-closed');
});

test('a second stall with the same signature reuses the action with zero provider calls', async () => {
  const memory = createMemory();
  const first = await diagnose({ stall: idle, provider: fakeProvider(card()), memory });
  const provider = fakeProvider(card({ class: 'infra' }));
  const second = await diagnose({ stall: idle, provider, memory });
  assert.equal(first.source, 'provider');
  assert.equal(second.source, 'memory');
  assert.equal(second.action, 'fixer');
  assert.equal(provider.calls, 0);
});

test('K successes promote a rule; a failed reuse demotes it and stops recall', () => {
  const memory = createMemory();
  const action = { class: 'code', action: 'fixer', delegate: 'fixer' };
  const at = 1;
  for (let i = 0; i < 2; i += 1) recordOutcome(memory, { signature: 's', action, outcome: 'success', at }, { promoteAfter: 3 });
  assert.equal(memory.rules.s, undefined);
  recordOutcome(memory, { signature: 's', action, outcome: 'success', at }, { promoteAfter: 3 });
  assert.equal(memory.rules.s.action, action);
  assert.equal(recallAction(memory, 's'), action);

  recordOutcome(memory, { signature: 's', action, outcome: 'failure', at: 2 }, { promoteAfter: 3 });
  assert.equal(memory.rules.s, undefined);
  assert.equal(recallAction(memory, 's'), null);
});

const patch = { stage: 'verify', class: 'rule-conflict', evidence: ['gate line 12 rejected'], rule_patch: 'runtime/lib/x.mjs: allow' };

test('an uncited rule-patch card is re-asked once and then produces no patch', async () => {
  const provider = fakeProvider(patch, patch);
  const result = await diagnose({ stall: idle, provider, memory: createMemory() });
  assert.equal(provider.calls, 2);
  assert.deepEqual({ action: result.action, delegate: result.delegate, source: result.source },
    { action: 'no-patch', delegate: null, source: 'fail-closed' });
});

test('a cited rule-patch card proposes a rule-patch and keeps its citations', async () => {
  const citations = ['log line 12: gate rejected', 'event 7'];
  const result = await diagnose({ stall: idle, provider: fakeProvider({ ...patch, citations }), memory: createMemory() });
  assert.deepEqual([result.action, result.delegate, result.citations], ['rule-patch', null, citations]);
});

test('KEEP is a normal outcome: no patch, no demotion, counters and rules unchanged', async () => {
  const memory = createMemory();
  const provider = fakeProvider(card({ class: 'rule-conflict', outcome: 'KEEP', citations: ['log line 3'] }));
  const result = await diagnose({ stall: idle, provider, memory });
  assert.equal(provider.calls, 1);
  assert.deepEqual([result.action, result.delegate], ['keep', null]);
  assert.equal(memory.entries[idle.signature].lastOutcome, 'keep');
  assert.equal(memory.entries[idle.signature].successes, 0);
  assert.equal(memory.entries[idle.signature].demoted, false);
  assert.deepEqual(memory.rules, {});
  await diagnose({ stall: idle, provider, memory });
  assert.equal(provider.calls, 2);
  const demoted = createMemory();
  demoted.entries[idle.signature] = { action: CLASS_ROUTES.code, successes: 0, demoted: true, at: 1 };
  await diagnose({ stall: idle, provider: fakeProvider(card({ outcome: 'KEEP' })), memory: demoted });
  assert.deepEqual(demoted.entries[idle.signature], { action: CLASS_ROUTES.code, successes: 0, demoted: true, at: 1 });
  assert.deepEqual(demoted.rules, {});
});

test('an invalid outcome value fails closed', async () => {
  const result = await diagnose({ stall: idle, provider: fakeProvider(card({ outcome: 'MAYBE' }), card({ outcome: 'MAYBE' })), memory: createMemory() });
  assert.equal(result.source, 'fail-closed');
});
