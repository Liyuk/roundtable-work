/** The sole squash merge entry point. The injected client owns all GitHub effects. */
export function createMergeEntryPoint({ github, gateState }) {
  if (!github || !gateState) throw new TypeError('github and gateState are required');
  for (const name of ['getPullRequest', 'requiredGreen', 'squashMerge']) {
    if (typeof github[name] !== 'function') throw new TypeError(`github.${name} is required`);
  }
  if (typeof gateState.get !== 'function') throw new TypeError('gateState.get is required');
  return async function squash(pr, evidence) {
    if (!evidence || typeof evidence.issue !== 'string' || !evidence.head || !evidence.tree || evidence.ciGreen !== true) {
      throw new Error('Complete gate evidence is required');
    }
    if (!Array.isArray(evidence.passed)) throw new Error('Gate evidence is malformed');
    const persisted = await gateState.get(evidence.issue);
    const required = ['gate0', 'gate1', ...(evidence.highRisk === true ? ['gate2'] : []), 'ci'];
    if (!persisted || persisted.issue !== evidence.issue || persisted.head !== evidence.head || persisted.tree !== evidence.tree ||
        !required.every((gate) => evidence.passed.includes(gate) && persisted.passed?.includes(gate))) {
      throw new Error('Gate evidence is missing or stale');
    }
    const live = await github.getPullRequest(pr);
    if (!live || live.state !== 'open' || live.draft === true || live.head !== evidence.head || live.mergeable !== true) {
      throw new Error('Pull request is not open, ready, current, and mergeable');
    }
    if (live.safetyFiles === true && (evidence.safetyApproved !== true || live.safetyApprovalHead !== evidence.head)) {
      throw new Error('Safety-file approval is missing or stale');
    }
    const checks = await github.requiredGreen(pr);
    if (checks !== true && checks?.green !== true) throw new Error('Required CI is red or pending');
    return github.squashMerge(pr, { method: 'squash' });
  };
}
