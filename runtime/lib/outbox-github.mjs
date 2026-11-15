// GitHub provider for the outbox: performs comment and label items through an injected writer.
// A comment carries its item id in a marker, and is posted only if no comment on the issue carries it yet, so a
// lost acknowledgement cannot post it twice.
export function createGitHubOutboxProvider({ writer }) {
  return {
    async deliver({ id, kind, issue, payload }) {
      if (kind === 'label') {
        await writer.addLabel(issue, payload.label);
        return { ok: true };
      }
      if (kind !== 'comment') throw new TypeError(`unsupported kind: ${kind}`);
      const marker = `<!-- rt:outbox ${id} -->`;
      const comments = await writer.listComments(issue);
      if (!comments.some((comment) => (comment.body ?? '').startsWith(marker))) await writer.createComment(issue, `${marker}\n${payload.body}`);
      return { ok: true };
    },
  };
}
