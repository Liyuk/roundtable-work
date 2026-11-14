import { readFile as readDiskFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Optional, read-only PR aftercare recorder. The caller supplies GitHub reads and
 * local persistence. Dispatch is a separate opt-in controller over injected work paths.
 *
 * client.getPullRequest() -> { state, merged, headSha, baseSha }
 * client.listComments({ after }) -> [{ id, body }]
 * client.getRequiredChecks({ headSha }) -> { conclusion }
 * client.compare({ baseSha, headSha }) -> { ahead, behind }
 * store.load()/save(record) are local-only operations.
 */
export function createAftercareRecorder({ enabled = false, client, store }) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  if (enabled && (!client || !store)) throw new TypeError('enabled recorder requires client and store');

  return {
    async poll() {
      // Keep the off path ahead of every provider or persistence access.
      if (!enabled) return { enabled: false, record: null, events: [] };
      for (const [name, methods] of Object.entries({
        client: ['getPullRequest', 'listComments', 'getRequiredChecks', 'compare'],
        store: ['load', 'save'],
      })) {
        for (const method of methods) {
          if (typeof (name === 'client' ? client : store)[method] !== 'function') {
            throw new TypeError(`${name}.${method} is required`);
          }
        }
      }

      const prior = (await store.load()) ?? freshRecord();
      if (prior.terminal) return { enabled: true, record: prior, events: [] };

      const pr = await client.getPullRequest();
      const terminal = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : null;
      const comments = await client.listComments({ after: prior.commentCursor });
      const checks = await client.getRequiredChecks({ headSha: pr.headSha });
      const compare = await client.compare({ baseSha: pr.baseSha, headSha: pr.headSha });
      const next = structuredClone(prior);
      const events = [];

      if (prior.headSha !== null && prior.headSha !== pr.headSha) events.push({ type: 'head_changed', headSha: pr.headSha });

      for (const comment of comments) {
        if (comment.id === undefined || comment.id === null) continue;
        const cursor = String(comment.id);
        if (next.seenCommentCursors.includes(cursor)) continue;
        next.seenCommentCursors.push(cursor);
        next.commentCursor = cursor;
        events.push({ type: 'new_comment', cursor });
      }

      if (next.baseSha !== null && next.baseSha !== pr.baseSha) events.push({ type: 'base_moved' });
      if (compare.behind > 0) events.push({ type: 'branch_behind', behind: compare.behind, ahead: compare.ahead });

      // Base sync is classified before CI so a sync conflict blocks a same-poll fix request.
      const conclusion = checks?.conclusion ?? 'pending';
      const checkKey = `${pr.headSha}:${conclusion}`;
      next.requiredCheck = { headSha: pr.headSha, conclusion };
      if (['success', 'failure'].includes(conclusion) && !next.seenCheckCursors.includes(checkKey)) {
        next.seenCheckCursors.push(checkKey);
        events.push({ type: conclusion === 'failure' ? 'ci_failure' : 'ci_success', headSha: pr.headSha });
      }
      next.baseSha = pr.baseSha;
      next.headSha = pr.headSha;
      next.ahead = compare.ahead;
      next.behind = compare.behind;
      if (terminal && next.terminal !== terminal) {
        next.terminal = terminal;
        events.push({ type: terminal });
      }
      next.suggestedAction = terminal ? 'stop' : events.some((event) => event.type === 'ci_failure') ? 'inspect_ci_failure' : 'observe';

      next.events = [...(prior.events ?? []), ...events.filter((event) =>
        event.type !== 'branch_behind' || prior.baseSha !== pr.baseSha || prior.headSha !== pr.headSha ||
        prior.ahead !== compare.ahead || prior.behind !== compare.behind)];

      // Persist only classifications, cursors, hashes, conclusions, and numeric relation state.
      await store.save(next);
      return { enabled: true, record: next, events };
    },
  };
}

/** Dispatch only through caller supplied work paths after explicit repository authorization. */
export function createAftercareDispatcher({ actions, store }) {
  if (!actions || !store) throw new TypeError('aftercare dispatcher requires actions and store');
  return {
    async handle({ config = {}, record, events = [] }) {
      const state = (await store.load()) ?? { fixRounds: 0, dispatched: [], reviewPending: null, waitReason: null };
      const next = structuredClone(state);
      const results = [];
      if (config.dispatchAftercareFixes !== true || record.terminal) {
        if (record.terminal) next.waitReason = `terminal:${record.terminal}`;
        await store.save(next);
        return { state: next, results };
      }
      if (next.waitReason === 'base sync conflict; waiting for resolution' || next.waitReason === 'base sync requires force-push; waiting for direction') {
        return { state: next, results };
      }
      const cap = Number.isInteger(config.maxFixRounds) && config.maxFixRounds >= 0 ? config.maxFixRounds : 0;
      for (const event of events) {
        if (event.type === 'ci_failure' && event.headSha === record.headSha) {
          const key = `ci_failure:${event.headSha}`;
          if (next.dispatched.includes(key)) continue;
          if (next.fixRounds >= cap) { next.waitReason = 'aftercare fix-round budget exhausted'; continue; }
          await actions.requestFix({ headSha: event.headSha });
          next.dispatched.push(key);
          next.fixRounds++;
          results.push({ type: 'fix_requested', headSha: event.headSha });
        } else if (event.type === 'branch_behind') {
          const key = `base_sync:${record.headSha}:${record.baseSha}`;
          if (next.dispatched.includes(key)) continue;
          const attempts = next.syncAttempts ?? 0;
          if (attempts >= 3) { next.waitReason = 'base sync budget exhausted'; results.push({ type: 'wait', reason: next.waitReason }); continue; }
          next.syncAttempts = attempts + 1;
          const result = await actions.syncBase({ headSha: record.headSha, force: false });
          if (result?.conflict || result?.requiresForcePush) {
            next.waitReason = result.conflict ? 'base sync conflict; waiting for resolution' : 'base sync requires force-push; waiting for direction';
            results.push({ type: 'wait', reason: next.waitReason });
            break;
          } else {
            next.dispatched.push(key);
            results.push({ type: 'base_sync_requested', headSha: record.headSha });
          }
        } else if (event.type === 'head_changed' && event.headSha === record.headSha) {
          next.reviewPending = event.headSha;
          const key = `review:${event.headSha}`;
          if (!next.dispatched.includes(key)) {
            await actions.requestReview({ headSha: event.headSha });
            next.dispatched.push(key);
            results.push({ type: 'review_requested', headSha: event.headSha });
          }
        }
      }
      if (next.reviewPending && !results.some((result) => result.type === 'wait')) {
        const evidence = await actions.getReviewEvidence({ headSha: next.reviewPending });
        if (evidence?.headSha === next.reviewPending) {
          await actions.recordReady({ headSha: next.reviewPending });
          results.push({ type: 'ready_recorded', headSha: next.reviewPending });
          next.reviewPending = null;
        }
      }
      await store.save(next);
      return { state: next, results };
    },
  };
}

const ACTIONS = ['requestFix', 'syncBase', 'requestReview', 'getReviewEvidence', 'recordReady'];
const OFF = { dispatchAftercareFixes: false, maxFixRounds: 1 };

/**
 * Load the tracked dispatch authorization. A missing, unreadable, or malformed file
 * can only resolve to off; this is the sole place dispatch becomes authorized.
 */
export async function readAftercareConfig({ readFile = readDiskFile, repoRoot = join(import.meta.dirname, '../..') } = {}) {
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, 'runtime', 'aftercare.config.json'), 'utf8'));
    if (typeof parsed.dispatchAftercareFixes === 'boolean' && Number.isInteger(parsed.maxFixRounds) && parsed.maxFixRounds >= 0) return parsed;
  } catch {}
  return { ...OFF };
}

/**
 * Recorder plus authorized dispatch over caller supplied actions and stores. Nothing
 * here creates a client or extends the caller's authority.
 */
export async function createAftercare({ recording = false, client, recordStore, dispatchStore, actions, readFile, repoRoot } = {}) {
  const config = await readAftercareConfig({ readFile, repoRoot });
  if (config.dispatchAftercareFixes) {
    const missing = ACTIONS.filter((name) => typeof actions?.[name] !== 'function');
    if (missing.length) throw new TypeError(`aftercare dispatch requires actions: ${missing.join(', ')}`);
  }
  const recorder = createAftercareRecorder({ enabled: recording, client, store: recordStore });
  const dispatcher = config.dispatchAftercareFixes ? createAftercareDispatcher({ actions, store: dispatchStore }) : null;
  return {
    async poll() {
      const result = await recorder.poll();
      if (!result.enabled || !dispatcher) return { ...result, dispatch: null };
      return { ...result, dispatch: await dispatcher.handle({ config, record: result.record, events: result.events }) };
    },
  };
}

function freshRecord() {
  return {
    version: 1,
    commentCursor: null,
    seenCommentCursors: [],
    seenCheckCursors: [],
    requiredCheck: null,
    headSha: null,
    baseSha: null,
    ahead: null,
    behind: null,
    terminal: null,
    suggestedAction: 'observe',
  };
}
