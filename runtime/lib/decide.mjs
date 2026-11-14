import { activeWindow, createModelRouter, validateRouting } from './routing.mjs';

export const LAYERS = Object.freeze(['triage', 'failure', 'escalate']);
const KINDS = Object.freeze(['deterministic', 'llm', 'disabled']);
const FAILURE_RETRY_LIMIT = 2;

export class DecisionDisabledError extends Error {
  constructor() {
    super('decision provider is disabled');
    this.name = 'DecisionDisabledError';
  }
}

// Each rule returns { decision, source } or null when it cannot decide.
const RULES = {
  triage: state => {
    const label = state.labels?.find(name => name.startsWith('type:'));
    return label ? { decision: label.slice('type:'.length), source: 'rule' } : null;
  },
  failure: state => ({ decision: (state.attempts ?? 0) < FAILURE_RETRY_LIMIT ? 'retry' : 'block', source: 'rule' }),
  escalate: () => ({ decision: 'ask', source: 'rule' }),
};

const ruleFor = layer => {
  if (!LAYERS.includes(layer)) throw new TypeError(`unknown decision layer: ${layer}`);
  return RULES[layer];
};

/** Create a provider. `routing` maps work type to model (see createModelRouter); the llm kind uses work type `chief`. */
export function createDecisionProvider({ kind = 'deterministic', completer, routing } = {}) {
  if (!KINDS.includes(kind)) throw new TypeError(`decision provider kind must be one of ${KINDS.join(', ')}`);
  if (kind === 'disabled') return { kind, decide: async () => { throw new DecisionDisabledError(); } };
  if (kind === 'deterministic') return { kind, decide: async ({ layer, state }) => ruleFor(layer)(state) };
  if (typeof completer !== 'function' || typeof routing !== 'function') throw new TypeError('llm provider requires completer and routing');
  return {
    kind,
    decide: async ({ layer, state, questions }) => {
      const ruled = ruleFor(layer)(state);
      if (ruled) return ruled;
      const out = await completer({ model: routing('chief'), layer, state, questions });
      return typeof out === 'string' && out.trim() ? { decision: out.trim(), source: 'model' } : null;
    },
  };
}

/** Parse provider config from env (RT_DECISION_PROVIDER, RT_* model keys) or an object with a routing table. */
export function parseDecisionConfig(input = process.env) {
  const kind = input.kind ?? input.RT_DECISION_PROVIDER ?? 'deterministic';
  if (input.routing) validateRouting(input.routing);
  if (kind !== 'llm') return { kind };
  const routing = input.routing
    ? () => activeWindow(input.routing, Date.now()).roles.chief.model
    : createModelRouter(input);
  return { kind, routing };
}

/** Choose the layer (dispute forces escalate), ask the provider, and fall back to the deterministic provider. */
export async function dispatchDecision({ provider, layer, state, questions, deterministic = createDecisionProvider() }) {
  const disputed = state.dispute === true || questions?.some(question => question?.dispute);
  const args = { layer: disputed ? 'escalate' : layer, state, questions };
  const decided = await decideOrNull(provider, args);
  return decided ?? await deterministic.decide(args);
}

async function decideOrNull(provider, args) {
  try {
    return await provider.decide(args);
  } catch (error) {
    if (error instanceof DecisionDisabledError) return null;
    throw error;
  }
}

/** Execution must not start without a planner checklist of non-empty steps. */
export function assertChecklistBeforeExecute(state) {
  const list = state.checklist;
  if (!Array.isArray(list) || list.length === 0 || list.some(item => typeof item !== 'string' || !item.trim())) {
    throw new TypeError('execute requires a non-empty planner checklist');
  }
}
