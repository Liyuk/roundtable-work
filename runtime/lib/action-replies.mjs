// Owner replies to action cards: `/rt confirm|rollback|amend <action-id>` on an owner_comment event. Each reply is checked
// against the journal state first; an unknown, illegal or non-owner reply is ignored and changes nothing.
import { ACTION_COMMANDS, parseRtCommand } from './rt-commands.mjs';
import { noticeId, openOutbox } from './outbox.mjs';

/** True while an action of this issue is rolling back: the line is held until the revert ends. */
export const isLineHeld = (journal, issue) => journal.list().some((a) => a.issue === issue && a.state === 'rolling_back');

export async function applyActionReply({ root, journal, inbox, owner, event, now = Date.now }) {
  const cmd = parseRtCommand(event.payload.body);
  if (!cmd.ok || !ACTION_COMMANDS.includes(cmd.command)) {
    return { outcome: 'ignored', reason: cmd.reason ?? 'not an action command' };
  }
  if (!owner || event.payload.author !== owner) return { outcome: 'ignored', reason: 'author is not the owner' };
  const action = journal.list().find((a) => a.id === cmd.actionId);
  if (!action) return { outcome: 'ignored', reason: `unknown action: ${cmd.actionId}` };
  const { id, issue, state } = action;
  if (cmd.command === 'confirm') {
    if (state !== 'executed_pending_confirmation') return { outcome: 'ignored', reason: `cannot confirm from ${state}` };
    journal.confirm(id);
    return { outcome: 'applied', state: 'settled' };
  }
  if (cmd.command === 'rollback') {
    if (!['executed_pending_confirmation', 'revert_failed'].includes(state) || !action.revert) return { outcome: 'ignored', reason: `cannot roll back from ${state}` };
    const result = await journal.rollback(id, { notify: () => {} });
    openOutbox(root).enqueue({ id: noticeId({ kind: 'action', actionId: id, state: result.state }), kind: 'notification', issue, payload: { subtype: 'rollback-result', actionId: id, state: result.state } });
    return { outcome: 'applied', state: result.state };
  }
  if (state !== 'executed_pending_confirmation') return { outcome: 'ignored', reason: `cannot amend from ${state}` };
  journal.requestAmend(id);
  inbox.accept({ source_event_id: `amend:${id}`, kind: 'owner_comment', issue, payload: { command: 'amend', actionId: id, text: cmd.text, sessionId: action.sessionId, author: event.payload.author }, receivedAt: now() });
  return { outcome: 'applied', state: 'amend_requested' };
}
