// Diagnoser contract, class routing, fail-closed re-ask and failure memory. Pure: the provider is
// injected and memory is a plain object (no fs), so tests can count provider calls.
import { signatureOf } from './stall.mjs';

export const DIAGNOSER = Object.freeze({ role: 'diagnoser', readOnly: true, tier: 'decider' });
export const DIAGNOSIS_CLASSES = Object.freeze(['infra', 'rule-conflict', 'code', 'unclear-spec']);
export const CLASS_ROUTES = Object.freeze({
  infra: Object.freeze({ action: 'rerun', delegate: null }),
  'rule-conflict': Object.freeze({ action: 'rule-patch', delegate: null }),
  code: Object.freeze({ action: 'fixer', delegate: 'fixer' }),
  'unclear-spec': Object.freeze({ action: 'clarify', delegate: null }),
});
const CARD_FIELDS = ['stage', 'class', 'evidence', 'rule_patch', 'action', 'citations', 'outcome'];
const nonEmpty = (text) => typeof text === 'string' && text.trim() !== '';
/** A card proposes a patch when it is rule-conflict or carries a rule_patch field. */
const proposesPatch = (card) => card?.class === 'rule-conflict' || card?.rule_patch !== undefined;

/** Deterministic pre-classification; only a fully cancelled required CI set is infra. */
export const classifyStall = (stall) => (stall.signal === 'ci-cancelled-only' ? 'infra' : null);

/** Strict card contract: unknown fields, a missing/unknown class or wrong types throw TypeError. */
function validateCard(card) {
  const lines = typeof card?.evidence === 'string' ? [card.evidence] : card?.evidence;
  const valid = card && typeof card === 'object' && Object.keys(card).every((key) => CARD_FIELDS.includes(key))
    && typeof card.stage === 'string' && card.stage.trim() !== '' && DIAGNOSIS_CLASSES.includes(card.class)
    && Array.isArray(lines) && lines.length > 0 && lines.every((line) => typeof line === 'string' && line.trim() !== '')
    && (card.rule_patch === undefined || typeof card.rule_patch === 'string')
    && (card.citations === undefined ? !proposesPatch(card) : Array.isArray(card.citations) && card.citations.length > 0 && card.citations.every(nonEmpty))
    && (card.outcome === undefined || card.outcome === 'FIX' || card.outcome === 'KEEP');
  if (!valid) throw new TypeError('invalid diagnoser card');
  return card;
}

export const createMemory = () => ({ entries: {}, rules: {} });

/** Recalled action for a signature, or null. A demoted signature is never recalled. */
export function recallAction(memory, signature) {
  const entry = memory.entries[signature];
  if (entry?.demoted || entry?.action === null) return null;
  return (memory.rules[signature] ?? memory.entries[signature])?.action ?? null;
}

/** Success counts toward promotion to a rule; failure demotes the entry and drops its rule. */
export function recordOutcome(memory, { signature, action, outcome, at }, { promoteAfter = 3 } = {}) {
  if (outcome === 'keep') {
    memory.entries[signature] ??= { action: null, successes: 0, demoted: false, lastOutcome: 'keep', at };
    return;
  }
  const entry = memory.entries[signature] ??= { action, successes: 0, demoted: false, at };
  if (outcome === 'failure') {
    delete memory.rules[signature];
    Object.assign(entry, { successes: 0, demoted: true });
    return;
  }
  entry.successes += 1;
  if (entry.successes >= promoteAfter) memory.rules[signature] = { action: entry.action, successes: entry.successes, at };
}

const decide = (memory, signature, cls, source) => {
  const route = { class: cls, ...CLASS_ROUTES[cls] };
  memory.entries[signature] ??= { action: route, successes: 0, demoted: false };
  return { ...route, signature, source };
};
const keep = (card, signature) => ({ class: card.class, action: 'keep', delegate: null, signature, source: 'provider' });

/**
 * Diagnose one stall. Order: deterministic class (no provider), recalled memory action (no provider),
 * then the provider with one re-ask on an invalid card or a throw; still invalid fails closed.
 * @param {{ stall: object, provider: { call(input: object): Promise<object> }, memory: object, maxReasks?: number }} args
 */
export async function diagnose({ stall, provider, memory, maxReasks = 1 }) {
  const signature = signatureOf(stall);
  const deterministic = classifyStall(stall);
  if (deterministic) return decide(memory, signature, deterministic, 'deterministic');
  const recalled = recallAction(memory, signature);
  if (recalled) return { ...recalled, signature, source: 'memory' };
  let patchProposed = false;
  for (let attempt = 0; attempt <= maxReasks; attempt += 1) {
    let raw;
    try {
      raw = await provider.call({ stall, attempt });
      const card = validateCard(raw);
      if (card.outcome === 'KEEP') {
        recordOutcome(memory, { signature, action: 'keep', outcome: 'keep', at: stall.at });
        return keep(card, signature);
      }
      return { ...decide(memory, signature, card.class, 'provider'), ...(card.citations && { citations: card.citations }) };
    } catch {
      patchProposed = proposesPatch(raw);
    }
  }
  if (patchProposed) return { class: 'rule-conflict', action: 'no-patch', delegate: null, signature, source: 'fail-closed' };
  return { class: 'unclear-spec', ...CLASS_ROUTES['unclear-spec'], signature, source: 'fail-closed' };
}
