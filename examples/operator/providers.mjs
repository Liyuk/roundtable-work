// Reference production providers. Every method is a fail-closed stub: shadow mode forwards only reads
// and never calls the live writes. Replace the stubs with real providers before a live run.
const stub = (name) => () => { throw new Error(`reference provider not configured: ${name}`); };
const methods = (prefix, names) => Object.fromEntries(names.map((name) => [name, stub(`${prefix}.${name}`)]));

export default {
  context: methods('context', ['get']),
  gates: methods('gates', ['gate0', 'reviewer', 'crossCheck']),
  github: methods('github', ['getPullRequest', 'setBase', 'requiredGreen', 'squashMerge', 'addLabel', 'recordedEscalationApproval', 'mainStatus', 'openRevertPullRequest', 'createIssue', 'createComment']),
  git: methods('git', ['createRevert', 'revertPlan']),
  observation: {
    issue: methods('observation.issue', ['get']),
    worktree: methods('observation.worktree', ['inspect']),
    git: methods('observation.git', ['head', 'commit']),
    evidence: methods('observation.evidence', ['checks', 'review']),
  },
};
