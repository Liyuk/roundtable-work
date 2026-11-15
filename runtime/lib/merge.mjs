import { safetyFiles } from './safety.mjs';
import { ledgerEntry } from './state.mjs';
import { buildPrRecord, validatePrRecord, extractPrRecord, upsertPrRecord } from './pr-record.mjs';
import { isDeepStrictEqual } from 'node:util';

const samePaths = (a, b) => a.length === b.length && a.every((path, index) => path === b[index]);
const isStringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** The sole squash merge entry point. The injected client owns all GitHub effects. */
export function createMergeEntryPoint({ github, gateState, store, pullRequestBody }) {
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
    const record = buildPrRecord({ issue: evidence.issue, head: persisted.head, tree: persisted.tree, passed: persisted.passed, rounds: evidence.roundMeta, usage: evidence.usage });
    const valid = validatePrRecord(record, { head: evidence.head, tree: evidence.tree, requiredGates: required });
    if (!valid.ok) throw new Error(`PR record is invalid: ${valid.reason}`);
    // The merge record lives in the ledger: a replayed squash for the same head returns the recorded merge instead of merging again.
    const mergeId = `merge:${evidence.head}`;
    if (store && ledgerEntry(await store.load(evidence.issue), mergeId)) return { replayed: true };
    const live = await github.getPullRequest(pr);
    if (!live || live.state !== 'open' || live.draft === true || live.head !== evidence.head || live.mergeable !== true) {
      throw new Error('Pull request is not open, ready, current, and mergeable');
    }
    // Safety approval is enforced on the live changed-file list, never on provider-supplied safety fields.
    // Missing live files fail closed: the caller cannot skip the check by omitting them.
    if (!isStringArray(live.files)) throw new Error('Live pull request changed files are required to verify safety approval');
    if (!isStringArray(persisted.safetyFiles)) throw new Error('Gated safety-file list is missing or malformed');
    const liveSafety = safetyFiles(live.files);
    const gatedSafety = [...new Set(persisted.safetyFiles)].sort();
    if (!samePaths(liveSafety, gatedSafety)) {
      throw new Error(`Safety-file set changed since gating: live [${liveSafety.join(', ')}] gated [${gatedSafety.join(', ')}]`);
    }
    if (liveSafety.length > 0 && persisted.safetyApproved !== true) {
      throw new Error('Safety-file approval is missing or stale for the current head and tree');
    }
    const checks = await github.requiredGreen(pr);
    if (checks !== true && checks?.green !== true) throw new Error('Required CI is red or pending');
    // The body must carry this exact record before squash; a missing body fails closed.
    const current = pullRequestBody ? await pullRequestBody.read(pr) : live.body;
    if (typeof current !== 'string') throw new Error('PR record check failed: pull request body not supplied');
    if (pullRequestBody) {
      try {
        await pullRequestBody.write(pr, upsertPrRecord(current, record));
      } catch (error) {
        throw new Error(`PR record update failed: ${error.message}`);
      }
      const reread = await pullRequestBody.read(pr);
      if (typeof reread !== 'string' || !isDeepStrictEqual(extractPrRecord(reread), record)) {
        throw new Error('PR record is missing or stale after the pull request body update');
      }
    } else if (!isDeepStrictEqual(extractPrRecord(current), record)) {
      throw new Error('PR record is missing or stale in the pull request body');
    }
    const merged = await github.squashMerge(pr, { method: 'squash', sha: live.head });
    if (store) await store.append(evidence.issue, { id: mergeId, type: 'merged', detail: { pr } });
    return merged;
  };
}
