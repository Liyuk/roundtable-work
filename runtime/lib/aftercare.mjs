/**
 * Optional, read-only PR aftercare recorder. The caller supplies GitHub reads and
 * local persistence; this module deliberately has no GitHub write/dispatch API.
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

      for (const comment of comments) {
        if (comment.id === undefined || comment.id === null) continue;
        const cursor = String(comment.id);
        if (next.seenCommentCursors.includes(cursor)) continue;
        next.seenCommentCursors.push(cursor);
        next.commentCursor = cursor;
        events.push({ type: 'new_comment', cursor });
      }

      const conclusion = checks?.conclusion ?? 'pending';
      const checkKey = `${pr.headSha}:${conclusion}`;
      next.requiredCheck = { headSha: pr.headSha, conclusion };
      if (['success', 'failure'].includes(conclusion) && !next.seenCheckCursors.includes(checkKey)) {
        next.seenCheckCursors.push(checkKey);
        events.push({ type: conclusion === 'failure' ? 'ci_failure' : 'ci_success', headSha: pr.headSha });
      }

      if (next.baseSha !== null && next.baseSha !== pr.baseSha) events.push({ type: 'base_moved' });
      if (compare.behind > 0) events.push({ type: 'branch_behind', behind: compare.behind, ahead: compare.ahead });
      next.baseSha = pr.baseSha;
      next.headSha = pr.headSha;
      next.ahead = compare.ahead;
      next.behind = compare.behind;
      if (terminal && next.terminal !== terminal) {
        next.terminal = terminal;
        events.push({ type: terminal });
      }
      next.suggestedAction = terminal ? 'stop' : events.some((event) => event.type === 'ci_failure') ? 'inspect_ci_failure' : 'observe';

      // Persist only cursors, hashes, conclusions, and numeric relation state; never comment text or author/repo data.
      await store.save(next);
      return { enabled: true, record: next, events };
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
