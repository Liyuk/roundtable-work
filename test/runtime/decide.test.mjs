import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DecisionDisabledError, assertChecklistBeforeExecute, createDecisionProvider, dispatchDecision, parseDecisionConfig,
} from '../../runtime/lib/decide.mjs';

const env = {
  RT_MODEL: 'vendor/standard-7',
  RT_REVIEWER_MODEL: 'vendor/standard-7',
  RT_DECIDER_MODEL: 'vendor/standard-7',
  RT_CROSSCHECK_MODEL: 'vendor/standard-7',
  RT_ALLOWED_MODELS: 'vendor/standard-7',
};
const entry = (model, tier = 'standard') => ({ harness: 'pi', model, tier });
const table = (chiefModel = 'vendor/standard-7') => ({
  version: 1,
  windows: [{
    id: 'w', from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z',
    roles: {
      chief: entry(chiefModel), developer: entry('vendor/standard-7'), fixer: entry('vendor/standard-7'),
      reviewer: entry('vendor/standard-7'), researcher: entry('vendor/standard-7'), crosscheck: entry('vendor/standard-7', 'strong'),
    },
  }],
});
const countingCompleter = (answer = 'bug') => {
  const calls = [];
  const completer = async (args) => { calls.push(args); return answer; };
  return { completer, calls };
};

test('deterministic triage uses an existing type label and never calls the model', async () => {
  const { completer, calls } = countingCompleter();
  const provider = createDecisionProvider({ kind: 'llm', completer, routing: createModelRouterFor(env) });
  const result = await dispatchDecision({ provider, layer: 'triage', state: { labels: ['type:docs'] }, questions: [] });
  assert.deepEqual(result, { decision: 'docs', source: 'rule' });
  assert.equal(calls.length, 0);
});

test('llm triage calls the injected completer with the chief-routed model only when rules cannot decide', async () => {
  const { completer, calls } = countingCompleter('feature');
  const provider = createDecisionProvider({ kind: 'llm', completer, routing: createModelRouterFor(env) });
  const result = await dispatchDecision({ provider, layer: 'triage', state: { labels: [] }, questions: [] });
  assert.deepEqual(result, { decision: 'feature', source: 'model' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'vendor/standard-7');
});

test('disabled and unconfigured providers fall back to the deterministic provider', async () => {
  const disabled = createDecisionProvider({ kind: 'disabled' });
  await assert.rejects(disabled.decide({ layer: 'triage', state: {} }), DecisionDisabledError);
  const state = { labels: ['type:bug'] };
  assert.deepEqual(await dispatchDecision({ provider: disabled, layer: 'triage', state }), { decision: 'bug', source: 'rule' });
  const unconfigured = createDecisionProvider({ kind: undefined });
  assert.deepEqual(await dispatchDecision({ provider: unconfigured, layer: 'triage', state }), { decision: 'bug', source: 'rule' });
  assert.deepEqual(parseDecisionConfig({}), { kind: 'deterministic' });
});

test('a dispute selects the escalate layer', async () => {
  const seen = [];
  const provider = { decide: async ({ layer }) => { seen.push(layer); return { decision: 'ask', source: 'fake' }; } };
  await dispatchDecision({ provider, layer: 'triage', state: { dispute: true }, questions: [] });
  await dispatchDecision({ provider, layer: 'failure', state: {}, questions: [{ dispute: true }] });
  await dispatchDecision({ provider, layer: 'failure', state: {}, questions: [] });
  assert.deepEqual(seen, ['escalate', 'escalate', 'failure']);
});

test('planner checklist gate requires a non-empty list of non-empty strings', () => {
  assert.throws(() => assertChecklistBeforeExecute({}), TypeError);
  assert.throws(() => assertChecklistBeforeExecute({ checklist: [] }), TypeError);
  assert.throws(() => assertChecklistBeforeExecute({ checklist: ['ok', ' '] }), TypeError);
  assert.doesNotThrow(() => assertChecklistBeforeExecute({ checklist: ['write tests'] }));
});

test('config parsing rejects unknown roles and empty model ids via the routing validator', () => {
  const unknownRole = table();
  unknownRole.windows[0].roles.deployer = entry('vendor/standard-7');
  assert.throws(() => parseDecisionConfig({ kind: 'llm', routing: unknownRole }), /unknown role "deployer"/);
  assert.throws(() => parseDecisionConfig({ kind: 'llm', routing: table('') }), /model/);
  assert.throws(() => parseDecisionConfig({ RT_DECISION_PROVIDER: 'llm', ...env, RT_CHIEF_MODEL: '' }), /RT_CHIEF_MODEL/);
  assert.deepEqual(parseDecisionConfig({ kind: 'llm', routing: table() }).kind, 'llm');
  assert.deepEqual(parseDecisionConfig({ RT_DECISION_PROVIDER: 'llm', ...env }).kind, 'llm');
});

function createModelRouterFor(values) {
  return parseDecisionConfig({ RT_DECISION_PROVIDER: 'llm', ...values }).routing;
}
