// Merge-time tiers (#604): with `mergeTiers` on, every daemon merge is classified by autonomyTier before the squash and
// journaled after it, using the same journal and notice path as the other actions. With the flag off the entry point is
// created exactly as before.
import { autonomyTier } from './autonomy.mjs';
import { createMergeEntryPoint } from './merge.mjs';
import { openActionJournal } from './action-journal.mjs';
import { notifyAction } from './daemon-asks.mjs';
import { readMergeTiers } from './merge-mode.mjs';
import { loadAutonomy } from './autonomy.mjs';

// The live pull request has no line count, so a merge that is not high risk is risk:medium: auto-notify, never silent.
// Labels are required: without them the owner override (rt:tier-approve) cannot be seen, so the merge fails closed.
export const mergeTierOf = (autonomy, revertOf) => (evidence, live) => {
  if (!Array.isArray(live.labels)) throw new Error('Live pull request labels are required to verify the owner override');
  return autonomyTier({ kind: 'merge', paths: live.files, labels: live.labels, risk: evidence.highRisk === true ? 'risk:high' : 'risk:medium', revertOf }, autonomy);
};

// A tier-aware squash returns { tier, reasons, result }. Journal the merge after it happens, and hand back the provider result.
// Replayed and held results merged nothing and pass through unrecorded.
export function recordTieredMerge(squash, root) {
  return async (pr, evidence) => {
    const out = await squash(pr, evidence);
    if (out.tier === undefined) return out;
    const issue = Number(evidence.issue);
    const journal = openActionJournal(root);
    await journal.perform({ action: { kind: 'merge', issue, key: evidence.head, reasons: out.reasons, before: {} }, tier: out.tier, apply: async () => ({ mergeCommit: out.result.mergeCommit }), notify: notifyAction(root, issue) });
    return out.result;
  };
}

/** The daemon's merge entry point. Off, it is `createMergeEntryPoint(options)`; on, it adds `tierOf` and journals the merge. */
export function createTieredMerge({ enabled, autonomy, root, revertOf, ...options }) {
  if (!enabled) return createMergeEntryPoint(options);
  return recordTieredMerge(createMergeEntryPoint({ ...options, tierOf: mergeTierOf(autonomy, revertOf) }), root);
}

/** Host outbox merges (#604, criterion 3) use the daemon's enable key, autonomy and tierOf. Resolves to a refusal reason, or null when the merge may proceed. */
export async function hostMergeRefusal({ readLive, evidence, revertOf, tiers = readMergeTiers, autonomy = loadAutonomy }) {
  if (!(await tiers())) return null;
  const tier = await mergeTierOf((await autonomy()).autonomy, revertOf)(evidence, await readLive());
  return tier.tier === 'approve-first' ? `approval required: ${tier.reasons.join(', ')}` : null;
}
