// GitHub provider for the outbox: performs comment, label and notification items through an injected writer.
// A comment or notification carries its item id in a marker, and is posted only if no comment on the issue carries it
// yet, so a lost acknowledgement cannot post it twice. A notification goes to its item's issue, or to the digest issue.
const NOTICE_TEXT = {
  'stall-alert': ({ of }) => `Stall alert for ${of}`,
  'approval-request': ({ of, action }) => `Approval requested for ${of}: ${action}`,
  'action-pending-confirmation': ({ issue, action }) => `Action ${action} on issue #${issue} awaits confirmation`,
  'done-pending-confirmation': ({ pr, head }) => `PR #${pr} merged (head ${head.slice(0, 7)}); awaiting owner confirmation or rollback`,
  'merge-confirmed': ({ pr }) => `Merge of PR #${pr} confirmed by the owner`,
  digest: ({ body }) => body,
};

export function createGitHubOutboxProvider({ writer, digestIssue = null }) {
  return {
    async deliver({ id, kind, issue, payload }) {
      if (kind === 'label') {
        await writer.addLabel(issue, payload.label);
        return { ok: true };
      }
      if (kind !== 'comment' && kind !== 'notification') throw new TypeError(`unsupported kind: ${kind}`);
      if (kind === 'notification' && !Object.hasOwn(NOTICE_TEXT, payload.subtype)) throw new TypeError(`unsupported notification subtype: ${payload.subtype}`);
      const body = kind === 'notification' ? NOTICE_TEXT[payload.subtype]({ issue, ...payload }) : payload.body;
      const target = kind === 'notification' ? issue ?? digestIssue : issue;
      const marker = `<!-- rt:outbox ${id} -->`;
      const comments = await writer.listComments(target);
      if (!comments.some((comment) => (comment.body ?? '').startsWith(marker))) await writer.createComment(target, `${marker}\n${body}`);
      return { ok: true };
    },
  };
}
