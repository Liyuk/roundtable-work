import { assertSafeId } from './paths.mjs';
import { safetyFiles } from './safety.mjs';

const PASS = (result) => result === true || result?.passed === true || result?.status === 'pass';
const UNAVAILABLE = (error) => error?.code === 'REVIEWER_UNAVAILABLE' || error?.unavailable === true;
const required = (value, name) => { if (!value || typeof value !== 'object') throw new TypeError(`${name} is required`); return value; };

/** A small durable gate record store. The host can inject a transactional state backend instead. */
export function createGateStateStore({ load, save }) {
  required({ load, save }, 'load/save');
  return {
    async get(issue) { return load(assertSafeId(issue)); },
    async put(issue, value) { return save(assertSafeId(issue), value); },
  };
}

/**
 * Run injected gates in order; only this orchestrator may authorize the merge entry point.
 *
 * Non-merge outcomes keep `status: 'blocked'` (the established "not merged" status) and carry a boolean
 * `hold` discriminator, so the caller can tell a resumable hold from a genuine failure:
 * - `hold: true` — nothing was merged and the same head/tree may be retried once the condition clears:
 *   pending CI, missing/stale recorded safety approval, reviewer unavailable after the retry, or a gate/CI
 *   provider that threw (a transient error).
 * - `hold: false` — an explicit gate verdict that did not pass, or a configuration error that will not
 *   clear by waiting (gate0/gate2 not-pass, reviewer rejection or stale-head evidence, missing cross-check).
 *   Required CI is a hold only while the provider reports `status: 'pending'`; red CI, or a not-green answer
 *   without an explicit pending status, is a genuine failure that escalates instead of waiting.
 * The caller must stay fail-closed on `hold: false` and must not treat a hold as a gate pass.
 */
export async function runGates({ issue, head, tree, highRisk = false, changedFiles = [], pr, gates, ci, merge, state, github, models = {}, routing, modelRouter }) {
  const id = assertSafeId(issue);
  if (![head, tree].every((v) => typeof v === 'string' && v.length)) throw new TypeError('head and tree are required');
  required(gates, 'gates'); required(ci, 'ci'); required(merge, 'merge'); required(state, 'state'); required(github, 'github');
  for (const method of ['gate0', 'reviewer']) if (typeof gates[method] !== 'function') throw new TypeError(`gates.${method} is required`);
  for (const method of ['requiredGreen']) if (typeof ci[method] !== 'function') throw new TypeError(`ci.${method} is required`);
  for (const method of ['squash']) if (typeof merge[method] !== 'function') throw new TypeError(`merge.${method} is required`);

  let record = await state.get(id);
  if (record && (record.issue !== id || record.head !== head || record.tree !== tree)) record = null;
  const passed = new Set(record?.passed ?? []);
  // The gated safety set is written on every persist so the merge entry point can compare it with the
  // live pull request. Approval is only proven once the escalation check has passed, which happens
  // before the `ci` persist; earlier persists keep it explicitly false.
  const gatedSafetyFiles = safetyFiles(changedFiles);
  const persist = async (gate) => {
    passed.add(gate);
    record = { issue: id, head, tree, passed: [...passed], safetyFiles: gatedSafetyFiles, safetyApproved: gate === 'ci' && gatedSafetyFiles.length > 0 };
    await state.put(id, record);
  };
  // `hold` separates a resumable wait from a genuine failure; see the runGates contract above. Default is
  // fail-closed (`hold: false`), so a new non-merge outcome never silently becomes retryable.
  const failed = async (gate, reason, hold = false) => ({ status: 'blocked', gate, reason, hold });
  // The routing file is the source of truth; the env work-type router is only a fallback for callers that inject it alone.
  const reviewModel = models.reviewer ?? modelRouter?.('review');
  const crossCheckModel = models.crossCheck ?? modelRouter?.('cross-check');

  if (!passed.has('gate0')) {
    let result;
    try { result = await gates.gate0({ issue: id, head, tree, changedFiles }); } catch (error) { return failed('gate0', error.message, true); }
    if (!PASS(result)) return failed('gate0', result?.reason ?? 'Gate 0 failed');
    await persist('gate0');
  }
  if (!passed.has('gate1')) {
    let result;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { result = await gates.reviewer({ issue: id, head, tree, model: reviewModel, ...(routing && { routing, role: routing.facts.roles.reviewer, prompt: routing.prompts.reviewer }), attempt: attempt + 1 }); }
      catch (error) { if (!UNAVAILABLE(error)) return failed('gate1', error.message, true); result = null; } // a thrown provider is transient until proven otherwise
      if (result && PASS(result) && result.head !== head) return failed('gate1', 'Reviewer evidence is missing current-head confirmation');
      if (result?.head && result.head !== head) return failed('gate1', 'Reviewer evidence is for a stale head');
      if (PASS(result)) break;
      if (result && !UNAVAILABLE(result)) return failed('gate1', result?.reason ?? 'Review did not pass');
      result = null;
    }
    if (!result) {
      await github.addLabel(pr, 'rt:ready-to-merge');
      return failed('gate1', 'Reviewer unavailable after one retry; labeled rt:ready-to-merge', true);
    }
    await persist('gate1');
  }
  if (highRisk && !passed.has('gate2')) {
    if (typeof gates.crossCheck !== 'function') return failed('gate2', 'High-risk diff has no cross-check implementation');
    if (!crossCheckModel) return failed('gate2', 'High-risk diff has no configured cross-check model');
    let result;
    try { result = await gates.crossCheck({ issue: id, head, tree, model: crossCheckModel, ...(routing && { routing, role: routing.facts.roles.crosscheck }), changedFiles }); }
    catch (error) { return failed('gate2', error.message, true); }
    if (!PASS(result)) return failed('gate2', result?.reason ?? 'Cross-check failed');
    await persist('gate2');
  }
  if (gatedSafetyFiles.length) {
    if (!crossCheckModel) {
      await github.addLabel(pr, 'rt:ready-to-merge');
      return failed('safety-approval', 'Safety-file changes require a configured cross-check model for recorded approval', true);
    }
    const approval = await github.recordedEscalationApproval(pr);
    const approvalModel = models.crossCheck ?? modelRouter?.('escalation');
    const modelApproved = approval?.approved === true && approval?.model === approvalModel && approval?.head === head;
    const live = modelApproved || typeof github.getPullRequest !== 'function' ? null : await github.getPullRequest(pr);
    const ownerApproved = live?.head === head && typeof live.ownerLogin === 'string' &&
      Array.isArray(live.comments) && live.comments.some((comment) =>
        typeof comment?.author?.login === 'string' && comment.author.login.toLowerCase() === live.ownerLogin.toLowerCase() &&
        typeof comment.body === 'string' && comment.body.includes('APPROVE-MERGE') && comment.body.includes(head));
    if (!modelApproved && !ownerApproved) {
      await github.addLabel(pr, 'rt:ready-to-merge');
      const fixable = approval?.reject === true && approval.inScope === true && approval.safetyGuardWeakening !== true &&
        typeof approval.fix === 'string' && approval.fix.trim() !== '' && typeof approval.reason === 'string' && approval.reason.trim() !== '';
      if (fixable) {
        await github.createComment(pr, `<!-- rt:safety-finding -->\nReason: ${approval.reason}\nFix: ${approval.fix}`);
        return { ...await failed('safety-approval', approval.reason), fix: approval.fix, retryable: true };
      }
      return failed('safety-approval', 'Safety-file changes require recorded escalation-model or current-head owner approval', true);
    }
  }
  let checks;
  try { checks = await ci.requiredGreen(pr); } catch (error) { return failed('ci', error.message, true); }
  // Required CI is only reported as green/not green plus an optional status. Pending is resumable; a not-green
  // answer without an explicit pending status is red, which must escalate rather than silently wait.
  if (checks !== true && checks?.green !== true) {
    const pending = checks?.status === 'pending';
    return failed('ci', pending ? 'Required CI is pending' : 'Required CI is red', pending);
  }
  await persist('ci');
  // The adapter is the single merge entry point and must revalidate live PR/head/CI immediately before squash.
  const evidence = { issue: id, head, tree, highRisk, passed: [...passed], ciGreen: true, safetyFiles: gatedSafetyFiles, safetyApproved: gatedSafetyFiles.length > 0 };
  const merged = await merge.squash(pr, evidence);
  return { status: 'merged', issue: id, head, tree, result: merged };
}

/** Recover an auto-merge that made main red. Every git/GitHub action is an injected side effect. */
export async function recoverRedMain({ mergeCommit, mainHead, mainRed, git, github, pause, merge }) {
  if (typeof mergeCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(mergeCommit)) throw new TypeError('mergeCommit must be a git SHA');
  required(git, 'git'); required(github, 'github'); required(pause, 'pause');
  if (typeof mainRed !== 'boolean' || typeof mainHead !== 'string') throw new TypeError('mainRed and mainHead are required');
  if (!mainRed || mainHead !== mergeCommit) return { status: 'no-action' };
  required(merge, 'merge');
  if (typeof merge.squash !== 'function' || typeof github.requiredGreen !== 'function') throw new TypeError('merge.squash and github.requiredGreen are required');
  await pause.claimsAndMerges({ paused: true, reason: 'main is red after auto-merge' });
  const branch = `rt/revert-${mergeCommit.slice(0, 7)}`;
  const revert = await git.createRevert({ mergeCommit, branch });
  const pr = await github.openRevertPullRequest({ branch, revert, title: `Revert ${mergeCommit.slice(0, 7)} after red main` });
  await github.createIssue({ title: `Investigate red main after auto-merge ${mergeCommit.slice(0, 7)}`, labels: ['type:bug', 'rt:self'], body: `Auto-merge ${mergeCommit} caused main CI to fail. Revert PR: #${pr.number}.` });
  const checks = await github.requiredGreen(pr.number);
  if (checks !== true && checks?.green !== true) return { status: 'revert-pending', branch, pr: pr.number, paused: true };
  await merge.squash(pr.number, { revert: true, head: pr.head });
  return { status: 'reverted', branch, pr: pr.number, paused: true };
}
