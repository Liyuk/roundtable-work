// Supervisor dispatch: observe records decisions only; apply also acts (requeue) on stale pause provenance.
export const MODES = Object.freeze(['observe', 'apply']);

const STALE_PAUSE = 'pause-provenance-stale';

export function dispatch({ mode, finding, ledger, actuator, parentId = null }) {
  if (!MODES.includes(mode)) throw new TypeError(`unknown mode: ${mode}`);
  if (mode === 'apply' && typeof actuator?.requeue !== 'function') throw new TypeError('apply mode requires actuator.requeue');
  const base = { mode, findingSignature: finding.signature };
  if (finding.rule !== STALE_PAUSE) {
    return [ledger.record({ ...base, action: 'observe-only', reason: finding.rule, parentId })];
  }
  const { ref, ageMs } = finding.evidence;
  const verb = mode === 'observe' ? 'would void' : 'voiding';
  const decision = ledger.record({ ...base, action: 'void-stale-pause', reason: `${verb} stale pause ${ref} (ageMs ${ageMs})`, parentId });
  if (mode === 'observe') return [decision];
  actuator.requeue(ref);
  const child = ledger.record({ ...base, action: 'requeue', reason: `requeued ${ref}`, parentId: decision.id, traceId: decision.traceId });
  return [decision, child];
}
