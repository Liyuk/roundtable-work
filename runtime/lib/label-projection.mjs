/** Labels the projection may add or remove. Every other label is left untouched. */
export const MANAGED_LABELS = Object.freeze(['rt:running', 'rt:ready-to-merge', 'rt:ask', 'rt:blocked']);

/** Gate names recorded in `state.gateRecord.passed` (see gates.mjs). */
const GATES = ['gate0', 'gate1', 'gate2'];

/** Pure: managed labels implied by the observed issue and state, first matching rule wins. */
export function deriveLabelState({ issue, state, highRisk = false }) {
  if (issue.state !== 'open') return [];
  if (state?.pause) return [state.pause.kind === 'ask' ? 'rt:ask' : 'rt:blocked'];
  const required = highRisk ? GATES : GATES.slice(0, 2);
  if (required.every((gate) => state?.gateRecord?.passed?.includes(gate))) return ['rt:ready-to-merge'];
  if (state && ['working', 'queued'].includes(state.status)) return ['rt:running'];
  return [];
}

/** Correct the managed labels of one issue to the derived state; log a `label_corrected` event when anything changed. */
export async function projectLabels({ number, observations, client, store, now = Date.now }) {
  const desired = deriveLabelState(observations);
  const current = observations.issue.labels.filter((label) => MANAGED_LABELS.includes(label));
  const added = desired.filter((label) => !current.includes(label));
  const removed = current.filter((label) => !desired.includes(label));
  for (const label of removed) await client.removeLabel(number, label);
  for (const label of added) await client.addLabel(number, label);
  const corrected = added.length + removed.length > 0;
  if (corrected) {
    await store.update(String(number), (s) => { s.lastEvent = { type: 'label_corrected', at: now(), detail: { added, removed } }; });
  }
  return { corrected, added, removed, desired };
}
