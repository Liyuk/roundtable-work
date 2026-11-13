const labelsOf = (issue) => (Array.isArray(issue?.labels) ? issue.labels : []).map((label) => typeof label === 'string' ? label : label?.name).filter(Boolean);
const validSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);

/**
 * Read current transition facts through injected read-only clients. This helper never receives a state store.
 * Observation across APIs is not atomic. The state store fences writes against stale lock epochs, not
 * changes to GitHub or the worktree. The merge entry point re-reads PR head and CI, but its squash provider
 * is not currently passed a conditional head. Injected GitHub effects remain subject to external races
 * and any conditional semantics supported by their providers. This snapshot is non-atomic: the final
 * write still requires a condition. State writes rely on lock-epoch fencing; GitHub/provider writes
 * rely only on provider conditional semantics and remain racy where no such condition exists.
 */
export async function observeAndCheckTransition({ clients, issue, expectedSha, phase }) {
  for (const name of ['issue', 'worktree', 'git', 'evidence']) {
    if (!clients?.[name]) throw new TypeError(`clients.${name} is required`);
  }
  const mismatches = [];
  const read = async (name, fn) => {
    try { return await fn(); }
    catch (error) { mismatches.push({ reason: `${name}_read_failed`, detail: error?.message ?? String(error) }); return null; }
  };
  const [issueFacts, worktreeFacts, head, commit, checks, review] = await Promise.all([
    read('issue', () => clients.issue.get(issue)),
    read('worktree', () => clients.worktree.inspect(issue)),
    read('head', () => clients.git.head(issue)),
    read('commit', () => clients.git.commit(issue)),
    ['developing', 'pre-gates'].includes(phase) ? null : read('checks', () => clients.evidence.checks(issue)),
    ['developing', 'testing', 'pre-gates'].includes(phase) ? null : read('review', () => clients.evidence.review(issue)),
  ]);
  const snapshot = {
    issue: issueFacts && { state: issueFacts.state, labels: labelsOf(issueFacts) },
    worktree: worktreeFacts && { dirty: worktreeFacts.dirty },
    head,
    commit,
    checks,
    review,
  };
  if (!issueFacts) { if (!mismatches.some((m) => m.reason === 'issue_read_failed')) mismatches.push({ reason: 'issue_unknown' }); }
  else {
    if (String(issueFacts.state).toLowerCase() !== 'open') mismatches.push({ reason: 'issue_not_open' });
    if (!labelsOf(issueFacts).includes('rt:running')) mismatches.push({ reason: 'issue_not_claimed' });
  }
  if (!worktreeFacts) { if (!mismatches.some((m) => m.reason === 'worktree_read_failed')) mismatches.push({ reason: 'worktree_unknown' }); }
  // Only intermediate implementation phases permit known dirty worktrees; completion and gates require clean.
  else if (worktreeFacts.dirty !== false && !(worktreeFacts.dirty === true && ['developing', 'testing', 'reviewing'].includes(phase))) mismatches.push({ reason: worktreeFacts.dirty === true ? 'worktree_dirty' : 'worktree_unknown' });
  if (!validSha(head)) mismatches.push({ reason: 'head_unknown' });
  if (!validSha(commit?.sha)) mismatches.push({ reason: 'commit_unknown' });
  if (validSha(head) && validSha(commit?.sha) && head !== commit.sha) mismatches.push({ reason: 'commit_head_mismatch' });
  if (!validSha(expectedSha)) mismatches.push({ reason: 'expected_sha_unknown' });
  if (validSha(head) && validSha(expectedSha) && head !== expectedSha) mismatches.push({ reason: 'head_sha_mismatch' });
  for (const [name, evidence, accepted] of [['checks', checks, ['success', 'passed', 'pass']], ['review', review, ['approved', 'passed', 'pass']]]) {
    if ((name === 'checks' && ['developing', 'pre-gates'].includes(phase)) || (name === 'review' && ['developing', 'testing', 'pre-gates'].includes(phase))) continue;
    if (!evidence) {
      if (!mismatches.some((m) => m.reason === `${name}_read_failed`)) mismatches.push({ reason: `${name}_unknown` });
      continue;
    }
    if (!validSha(evidence.sha)) mismatches.push({ reason: `${name}_sha_unknown` });
    else if (validSha(head) && evidence.sha !== head) mismatches.push({ reason: `${name}_sha_mismatch` });
    if (!accepted.includes(String(evidence.conclusion ?? evidence.status).toLowerCase())) mismatches.push({ reason: `${name}_not_passed` });
  }
  return { allowed: mismatches.length === 0, snapshot, mismatches, decision: mismatches.length ? 'wait' : 'continue' };
}
