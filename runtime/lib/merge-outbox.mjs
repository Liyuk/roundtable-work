// Merge outbox: the squash, the done-pending-confirmation notice and the rollback are outbox items, and the owner's
// /rt confirm|rollback replies on a merge notice are checked against the notice receipt before anything is enqueued.
// Item builders are pure; the outbox is only touched through openOutbox, so this module runs no subprocess.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRtCommand } from './rt-commands.mjs';
import { noticeId, openOutbox } from './outbox.mjs';

export const mergeItem = ({ issue, pr, head }) => ({ id: `merge:${pr}:${head}`, kind: 'merge', issue, payload: { op: 'squash', pr, head } });

export const mergedNotice = ({ issue, pr, head }) => ({ id: noticeId({ kind: 'merge', pr, head }), kind: 'notification', issue, payload: { subtype: 'done-pending-confirmation', pr, head } });

export const rollbackItem = ({ issue, pr, head, mergeSha }) => ({ id: `rollback:merge:${pr}:${head}`, kind: 'merge', issue, payload: { op: 'rollback', pr, head, mergeSha } });

// A rollback for the same pr/head is refused while its first request is in the outbox, so a cause rolls back once.
export function requestRollback(root, cause) {
  return openOutbox(root).enqueue(rollbackItem(cause)) ? { ok: true } : { ok: false, reason: 'already-requested' };
}

// The merge commit of a merge rt-merge recorded in state/merges.log (columns: time, pr, issue, merge sha, head sha).
function mergeShaOf(root, pr, head) {
  const log = join(root, 'state', 'merges.log');
  if (!existsSync(log)) return undefined;
  const row = readFileSync(log, 'utf8').split('\n').map((l) => l.split('\t')).find((c) => c[1] === String(pr) && c[4] === head);
  return row?.[3];
}

// Owner replies: `/rt confirm merge:<pr>:<head>` and `/rt rollback merge:<pr>:<head>`. Only a merge whose
// done-pending-confirmation notice has a receipt is accepted; anything else is ignored and enqueues nothing.
export function applyMergeReply({ root, owner, event }) {
  const cmd = parseRtCommand(event.payload.body);
  if (!cmd.ok || !['confirm', 'rollback'].includes(cmd.command)) return { outcome: 'ignored', reason: cmd.reason ?? 'not a merge command' };
  if (!owner || event.payload.author !== owner) return { outcome: 'ignored', reason: 'author is not the owner' };
  const m = cmd.actionId.match(/^merge:(\d+):([0-9a-f]+)$/);
  if (!m) return { outcome: 'ignored', reason: `not a merge id: ${cmd.actionId}` };
  const pr = Number(m[1]);
  const head = m[2];
  const outbox = openOutbox(root);
  const notice = outbox.items().find((i) => i.id === noticeId({ kind: 'merge', pr, head }));
  if (!notice || !outbox.receipts().has(notice.id)) return { outcome: 'ignored', reason: `no delivered notice for merge ${pr} ${head}` };
  const { issue } = notice;
  if (cmd.command === 'confirm') {
    const item = { id: `confirm:merge:${pr}:${head}`, kind: 'notification', issue, payload: { subtype: 'merge-confirmed', pr, head } };
    return outbox.enqueue(item) ? { outcome: 'applied', state: 'confirmed' } : { outcome: 'ignored', reason: 'already confirmed' };
  }
  const mergeSha = mergeShaOf(root, pr, head);
  if (!mergeSha) return { outcome: 'ignored', reason: `no merge record for ${pr} ${head}` };
  const r = requestRollback(root, { issue, pr, head, mergeSha });
  return r.ok ? { outcome: 'applied', state: 'rollback-requested' } : { outcome: 'ignored', reason: r.reason };
}
