/** Labels the projection may add or remove. Every other label is left untouched. */
export const MANAGED_LABELS = Object.freeze(['rt:running', 'rt:ready-to-merge', 'rt:ask', 'rt:blocked']);

/** Gate names recorded in `state.gateRecord.passed` (see gates.mjs). */
const GATES = ['gate0', 'gate1', 'gate2'];

/** Pure: managed labels implied by the observed issue and state, first matching rule wins. */
export function deriveLabelState({ issue, state, highRisk = false }) {
  if (issue.state !== 'open') return [];
  if (state?.pause) return [state.pause.kind === 'ask' ? 'rt:ask' : 'rt:blocked'];
  // A blocked label outranks any stale ready-to-merge label left by an earlier attempt.
  if (issue.labels?.includes('rt:blocked')) return ['rt:blocked'];
  const required = highRisk ? GATES : GATES.slice(0, 2);
  if (required.every((gate) => state?.gateRecord?.passed?.includes(gate))) return ['rt:ready-to-merge'];
  if (state && ['working', 'queued'].includes(state.status)) return ['rt:running'];
  return [];
}

/** Correct the managed labels of one issue to the derived state; log a `label_corrected` event when anything changed. */
export async function projectLabels({ number, issue, highRisk = false, client, store, now = Date.now }) {
  // The state is read from the same store the projection writes to: there is no second copy to drift from.
  const state = await store.load(String(number));
  const labels = issue.labels.map((label) => typeof label === 'string' ? label : label.name);
  const desired = deriveLabelState({ issue: { ...issue, labels }, state, highRisk });
  const current = labels.filter((label) => MANAGED_LABELS.includes(label));
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
