/**
 * Compose the runtime's production completion adapter from trusted providers.
 *
 * context.get receives the worker completion arguments, or { recovery: { pr, issue, mergeCommit } }
 * for a revert, and returns { pr, head, tree, highRisk, changedFiles }. Gate providers follow the
 * runGates contract. github.getPullRequest must return { state, draft, head, mergeable, files } and,
 * for owner safety approval, { ownerLogin, comments: [{ author: { login }, body }] }, where
 * files is the pull request's changed paths: the merge entry point derives the safety-file set from it
 * and fails closed when it is absent; the monitor uses `state: 'merged'`/`merged: true` with an optional
 * `mergeCommit` SHA to resolve a merge whose outcome was unknown, and a closed pull request must report
 * `merged: false` to be treated as unmerged. github.squashMerge resolves only after a successful squash and returns
 * { mergeCommit: <SHA> }; github.mainStatus returns { head, status: 'green'|'red'|'pending' }.
 * Recovery providers return the revert result, { number, head } for the PR, and { number } for the
 * bug issue. GitHub and git effects are owned by the supplied providers.
 *
 * An optional pause provider implements get({ epoch })/put(record, { epoch }), with durable, atomic
 * storage shared by all passes of this work root and rejection of writes from stale lock epochs. Without one, the runtime's fenced state store persists the record.
 */
export function createProductionAdapter(providers = {}) {
  for (const [name, methods] of Object.entries({
    context: ['get'], gates: ['gate0', 'reviewer', 'crossCheck'],
    github: ['getPullRequest', 'requiredGreen', 'squashMerge', 'addLabel', 'recordedEscalationApproval', 'mainStatus', 'openRevertPullRequest', 'createIssue', 'createComment'],
    git: ['createRevert'],
  })) {
    for (const method of methods) {
      if (typeof providers[name]?.[method] !== 'function') throw new TypeError(`provider ${name}.${method} is required`);
    }
  }
  for (const [name, methods] of Object.entries({ issue: ['get'], worktree: ['inspect'], git: ['head', 'commit'], evidence: ['checks', 'review'] })) {
    for (const method of methods) {
      if (typeof providers.observation?.[name]?.[method] !== 'function') throw new TypeError(`provider observation.${name}.${method} is required`);
    }
  }
  if (providers.pause && (typeof providers.pause.get !== 'function' || typeof providers.pause.put !== 'function')) throw new TypeError('provider pause.get and pause.put are required');
  return { pause: providers.pause, context: (args) => providers.context.get(args), gates: providers.gates, github: providers.github, git: providers.git, observationClients: providers.observation, production: true };
}
