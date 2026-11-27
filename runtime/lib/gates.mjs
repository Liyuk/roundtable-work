import { assertSafeId } from './paths.mjs';
import { safetyFiles } from './safety.mjs';
import { gate2Triggers } from './gate2-triggers.mjs';
import { triageFindings } from './review-ledger.mjs';
import { localCheckEntry, localCheckPasses, ciAllowsMerge } from './local-checks.mjs';
import { findDanglingImports } from './revert-check.mjs';
import { findBreakingCommit } from './red-main.mjs';

// A single-session (`independent: false`) review is never a Gate 1 pass, whatever its verdict says.
const PASS = (result) => result?.independent !== false && (result === true || result?.passed === true || result?.status === 'pass');
const UNAVAILABLE = (error) => error?.code === 'REVIEWER_UNAVAILABLE' || error?.unavailable === true;
const required = (value, name) => { if (!value || typeof value !== 'object') throw new TypeError(`${name} is required`); return value; };
/** How many cancelled-only CI re-runs one issue may request before a cancelled answer fails closed. */
export const MAX_CI_RERUNS = 2;
/** Ledger entry type recorded once per requested CI re-run. */
const CI_RERUN = 'ci_rerun';
/** How many attempts a recorded-approval read gets before the gate holds for a later pass. */
const MAX_APPROVAL_READS = 3;

/** Pure: true when the pull request body closes `issueNumber` with a GitHub closing keyword (`Closes #N`). */
export const closesLink = (body, issueNumber) => new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+#${Number(issueNumber)}(?!\\d)`, 'i').test(String(body ?? ''));

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
 *   pending CI, missing/stale recorded safety approval, reviewer unavailable after the retry, a gate/CI
 *   provider that threw (a transient error), or `review_precondition` (dirty worktree or HEAD not the pushed PR head;
 *   the reviewer is not dispatched).
 * - `hold: false` — an explicit gate verdict that did not pass, or a configuration error that will not
 *   clear by waiting (gate0/gate2 not-pass, reviewer rejection or stale-head evidence, missing cross-check).
 *   Required CI is a hold while the provider reports `status: 'pending'`; red CI, or a not-green answer
 *   without an explicit pending status, is a genuine failure that escalates instead of waiting. A cancelled-only
 *   answer is also a hold while an optional `ci.rerunCancelled(pr)` capability exists and the persisted budget
 *   (`MAX_CI_RERUNS` per issue, counted from `ci_rerun` ledger entries via `store`) is not used up; otherwise it is
 *   red and fails closed as before.
 * Absent required CI (`status: 'absent'`) passes only when `localChecks.enabled` is true and the ledger holds a passing
 * `local-check:<head>` record; otherwise, with an injected `gates.localCheck({ issue, head, tree, command })` provider,
 * exit code 0 records it and a non-zero exit or missing provider blocks (`hold: false`), and a throwing provider holds.
 * A pull request whose body does not close the issue (`closesLink`) fails the `pr-link` gate with `hold: false`
 * before any review, so the merge never proceeds for an unlinked loop PR.
 * The caller must stay fail-closed on `hold: false` and must not treat a hold as a gate pass.
 */
export async function runGates({ issue, head, tree, highRisk = false, changedFiles = [], pr, gates, ci, merge, state, store, github, models = {}, routing, modelRouter, escalation, precondition, localChecks = { enabled: false }, requireClosesLink = true, usageRows = [] }) {
  const id = assertSafeId(issue);
  if (![head, tree].every((v) => typeof v === 'string' && v.length)) throw new TypeError('head and tree are required');
  required(gates, 'gates'); required(ci, 'ci'); required(merge, 'merge'); required(state, 'state'); required(github, 'github');
  for (const method of ['gate0', 'reviewer']) if (typeof gates[method] !== 'function') throw new TypeError(`gates.${method} is required`);
  for (const method of ['requiredGreen']) if (typeof ci[method] !== 'function') throw new TypeError(`ci.${method} is required`);
  for (const method of ['squash']) if (typeof merge[method] !== 'function') throw new TypeError(`merge.${method} is required`);

  const stored = await state.get(id);
  let record = stored;
  if (record && (record.issue !== id || record.head !== head || record.tree !== tree)) record = null;
  const passed = new Set(record?.passed ?? []);
  // Round metadata per gate is persisted with the record, so a resumed merge still records the gate 1 and gate 2 agents.
  const roundMeta = { ...record?.roundMeta };
  // Gate 2 triggers are recorded with the gate; a resumed record without them is treated as requiring Gate 2 (rationale unknown).
  let gate2Reasons = record?.gate2Reasons ?? gate2Triggers({ changedFiles });
  // The gated safety set is written on every persist so the merge entry point can compare it with the
  // live pull request. Approval is only proven once the escalation check has passed, which happens
  // before the `ci` persist; earlier persists keep it explicitly false.
  const gatedSafetyFiles = safetyFiles(changedFiles);
  const persist = async (gate) => {
    if (gate) passed.add(gate);
    record = { issue: id, head, tree, passed: [...passed], roundMeta, gate2Reasons, safetyFiles: gatedSafetyFiles, safetyApproved: gate === 'ci' && gatedSafetyFiles.length > 0 };
    await state.put(id, record);
  };
  // `hold` separates a resumable wait from a genuine failure; see the runGates contract above. Default is
  // fail-closed (`hold: false`), so a new non-merge outcome never silently becomes retryable.
  const failed = async (gate, reason, hold = false) => ({ status: 'blocked', gate, reason, hold });
  // The routing file is the source of truth; the env work-type router is only a fallback for callers that inject it alone.
  const reviewModel = models.reviewer ?? modelRouter?.('review');
  const crossCheckModel = models.crossCheck ?? modelRouter?.('cross-check');

  let body;
  try { ({ body } = await github.getPullRequest(pr)); } catch (error) { return failed('pr-link', error.message, true); }
  if (requireClosesLink && !closesLink(body, id)) return failed('pr-link', `Pull request body must close the issue with "Closes #${id}"`);
  if (!passed.has('gate0')) {
    let result;
    try { result = await gates.gate0({ issue: id, head, tree, changedFiles }); } catch (error) { return failed('gate0', error.message, true); }
    if (!PASS(result)) return failed('gate0', result?.reason ?? 'Gate 0 failed');
    await persist('gate0');
  }
  if (!passed.has('gate1')) {
    const unclean = await precondition?.({ head, pr });
    if (unclean) return { ...await failed('gate1', 'review_precondition', true), detail: unclean };
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
    gate2Reasons = gate2Triggers({ changedFiles, gate1: result });
    if (routing) roundMeta.gate1 = { role: 'reviewer', harness: result.harness ?? routing.facts.roles.reviewer.harness, model: reviewModel };
    await persist('gate1');
  }
  if ((highRisk || gate2Reasons.length > 0) && !passed.has('gate2')) {
    if (typeof gates.crossCheck !== 'function') return failed('gate2', 'High-risk diff has no cross-check implementation');
    if (!crossCheckModel) return failed('gate2', 'High-risk diff has no configured cross-check model');
    let result;
    try { result = await gates.crossCheck({ issue: id, head, tree, model: crossCheckModel, ...(routing && { routing, role: routing.facts.roles.reviewer }), changedFiles }); }
    catch (error) { return failed('gate2', error.message, true); }
    if (!PASS(result)) {
      const reason = result?.reason ?? 'Cross-check failed';
      // Gate 1 passed but Gate 2 disagrees: hand the disagreement to the escalation adapter, never back to the developer.
      if (typeof escalation !== 'function') return failed('gate2', reason);
      await escalation({ issue: id, head, tree, model: modelRouter?.('escalation'), disagreement: { gate1: 'pass', gate2: 'fail', reason } });
      return { ...await failed('gate2', reason), escalated: true };
    }
    if (routing) roundMeta.gate2 = { role: 'crosscheck', harness: result.harness ?? routing.facts.roles.reviewer.harness, model: crossCheckModel };
    await persist('gate2');
  }
  if (gatedSafetyFiles.length) {
    if (!crossCheckModel) {
      await github.addLabel(pr, 'rt:ready-to-merge');
      return failed('safety-approval', 'Safety-file changes require a configured cross-check model for recorded approval', true);
    }
    let approval;
    // A missed read (a throw or an empty result) is retried a bounded number of times; if it is still missing the gate
    // holds for a later pass (or the owner check below), never a rejection.
    for (let attempt = 1; ; attempt++) {
      try { approval = await github.recordedEscalationApproval(pr); }
      catch (error) { approval = null; if (attempt === MAX_APPROVAL_READS) { await github.addLabel(pr, 'rt:ready-to-merge'); return failed('safety-approval', `Recorded approval could not be read: ${error.message}`, true); } }
      if (approval || attempt === MAX_APPROVAL_READS) break;
    }
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
  // Absent CI (nothing auto-runs) may pass through the opt-in local check: run the injected provider once per head.
  let ledger = [];
  if (localChecks.enabled && checks?.status === 'absent') {
    ledger = (await store.load(id)).ledger;
    if (!localCheckPasses(ledger, head) && typeof gates.localCheck === 'function') {
      let result;
      try { result = await gates.localCheck({ issue: id, head, tree, command: localChecks.command }); } catch (error) { return failed('ci', error.message, true); }
      if (result?.exitCode !== 0) return failed('ci', 'Local check failed');
      const entry = localCheckEntry({ head, tree, command: localChecks.command });
      await store.append(id, entry);
      ledger = [...ledger, entry];
    }
  }
  // Required CI is only reported as green/not green plus an optional status. Pending is resumable; a not-green
  // answer without an explicit pending status is red, which must escalate rather than silently wait.
  if (!ciAllowsMerge({ checks, enabled: localChecks.enabled, ledger, head })) {
    // The re-run budget is the count of ledger entries for this issue, so it survives a crash and a head change.
    if (checks?.status === 'cancelled' && typeof ci.rerunCancelled === 'function') {
      const ciReruns = (await store.load(id)).ledger.filter((entry) => entry.type === CI_RERUN).length;
      if (ciReruns < MAX_CI_RERUNS) {
        // Record the re-run before the side effect, so a throwing provider cannot cause unbounded re-runs.
        await store.append(id, { id: `${CI_RERUN}:${ciReruns + 1}`, type: CI_RERUN, detail: { pr } });
        await ci.rerunCancelled(pr);
        return failed('ci', `Required CI was cancelled by the runner; re-run requested (${ciReruns + 1}/${MAX_CI_RERUNS})`, true);
      }
    }
    // A CI-wait timeout is not a failure: it holds like a pending run and is retried on a later pass.
    const pending = checks?.status === 'pending' || checks?.status === 'timeout';
    return failed('ci', pending ? 'Required CI is pending' : 'Required CI is red', pending);
  }
  await persist('ci');
  // The adapter is the single merge entry point and must revalidate live PR/head/CI immediately before squash.
  // Usage is recorded only for calls whose tokens are known; with none, the merge record states usageKnown: false.
  const known = usageRows.filter((row) => row.usageKnown === true);
  const total = (key) => known.reduce((sum, row) => sum + row[key], 0);
  const usage = known.length ? { inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), calls: known.length } : undefined;
  const evidence = { issue: id, head, tree, highRisk, passed: [...passed], ciGreen: true, safetyFiles: gatedSafetyFiles, safetyApproved: gatedSafetyFiles.length > 0, roundMeta, usage };
  const merged = await merge.squash(pr, evidence);
  return { status: 'merged', issue: id, head, tree, result: merged };
}

/** A fix round starts only for blocking findings that are new or still open from an earlier round. */
export const startsFixRound = (findings, previous = []) => triageFindings(findings, previous).some(finding => finding.fix);

/** Recover an auto-merge that made main red. Every git/GitHub action is an injected side effect. */
export async function recoverRedMain({ mergeCommit, mainHead, mainRed, history = [], git, github, pause, merge }) {
  if (typeof mergeCommit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(mergeCommit)) throw new TypeError('mergeCommit must be a git SHA');
  required(git, 'git'); required(github, 'github'); required(pause, 'pause');
  if (typeof mainRed !== 'boolean' || typeof mainHead !== 'string') throw new TypeError('mainRed and mainHead are required');
  if (!mainRed || mainHead !== mergeCommit) return { status: 'no-action' };
  required(merge, 'merge');
  if (typeof merge.squash !== 'function' || typeof github.requiredGreen !== 'function') throw new TypeError('merge.squash and github.requiredGreen are required');
  await pause.claimsAndMerges({ paused: true, reason: 'main is red after auto-merge' });
  const target = findBreakingCommit(history) ?? mergeCommit;
  const branch = `rt/revert-${target.slice(0, 7)}`;
  const investigate = (body) => github.createIssue({ title: `Investigate red main after auto-merge ${target.slice(0, 7)}`, labels: ['type:bug', 'rt:self', 'priority:p0'], body });
  const dangling = findDanglingImports(await git.revertPlan({ mergeCommit: target }));
  if (dangling.length) {
    const refs = dangling.map(({ file, specifier }) => `${file} imports ${specifier}`).join('; ');
    await investigate(`Revert of ${target} is blocked: it would leave dangling references (${refs}). Main stays paused until they are resolved by hand.`);
    return { status: 'blocked-dangling', branch, dangling, paused: true };
  }
  const revert = await git.createRevert({ mergeCommit: target, branch });
  const body = `Reverts breaking commit ${target} onto branch ${branch}. Dangling references: none. The required green check gates the merge.`;
  const pr = await github.openRevertPullRequest({ branch, revert, title: `Revert ${target.slice(0, 7)} after red main`, body });
  await investigate(`Auto-merge ${target} caused main CI to fail. Revert PR: #${pr.number}.`);
  const checks = await github.requiredGreen(pr.number);
  if (checks !== true && checks?.green !== true) return { status: 'revert-pending', branch, pr: pr.number, paused: true };
  await merge.squash(pr.number, { revert: true, head: pr.head });
  return { status: 'reverted', branch, pr: pr.number, paused: true };
}
