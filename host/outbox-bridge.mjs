// Host bridge (host-side glue, so it may run gh; runtime/ stays free of subprocesses): rt-work.sh and rt-sched.py send their comments, label add/remove and notifications through the durable outbox.
// Each call enqueues one item (before its gh call), then delivers only that item with the real gh.
// A failed item is recorded and dead-lettered, never retried, so a stale write cannot land after a later one. Exit 0 only when this call's item was delivered.
//   node host/outbox-bridge.mjs <root> <repo> comment <issue> <bodyFile|->   (body from stdin when "-")
//   node host/outbox-bridge.mjs <root> <repo> label <issue> add|rm <label>
//   node host/outbox-bridge.mjs <root> <repo> merge <issue|""> <pr> <head> <highRisk 0|1>     (tier-gated squash; then the done-pending-confirmation notice)
//   node host/outbox-bridge.mjs <root> <repo> rollback <issue|""> <pr> <head> <mergeSha>   (runs bin/rt-revert)
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHubOutboxProvider } from '../runtime/lib/outbox-github.mjs';
import { openOutbox } from '../runtime/lib/outbox.mjs';
import { mergeItem, mergedNotice, requestRollback, rollbackItem } from '../runtime/lib/merge-outbox.mjs';
import { hostMergeRefusal } from '../runtime/lib/merge-tier.mjs';
import { loadImRouter, withIm } from '../runtime/lib/outbox-im.mjs';
import { fetchTransport } from '../scripts/im-transport.mjs';

// Comment ids derive from the body, so a replayed identical comment is refused by enqueue. Accepted trade-off: identical text on the same issue is posted once.
export const commentItem = (issue, body) => ({ id: `comment:${issue}:${createHash('sha256').update(body).digest('hex').slice(0, 16)}`, kind: 'comment', issue, payload: { body } });

// Label ids are unique per write, so an add, remove, add cycle is three distinct writes.
export function labelItem(issue, op, label) {
  if (op !== 'add' && op !== 'rm') throw new TypeError(`label op must be add or rm: ${op}`);
  return { id: `label:${issue}:${op}:${label}:${randomUUID()}`, kind: 'label', issue, payload: { op, label } };
}

// The gh writer runs the real CLI with an argument array (no shell). gh's stderr is passed through on failure.
export function ghWriter({ gh, repo, rtHome }) {
  const run = (file, args, input, env) => {
    const r = spawnSync(file, args, { encoding: 'utf8', input, env });
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      throw new Error(r.stderr.trim().slice(0, 200));
    }
    return r.stdout;
  };
  const ghRun = (args, input) => run(gh, args, input);
  return {
    squashMerge: (pr, head, issue) => ghRun(['pr', 'merge', String(pr), '-R', repo, '--squash', '--match-head-commit', head, '--body', issue ? `Closes #${issue}` : '']),
    // Reverts through the existing mechanism (bin/rt-revert reads state/merges.log under RT_HOME).
    revertMerge: (mergeSha) => run(join(rtHome, 'bin', 'rt-revert'), [mergeSha], undefined, { ...process.env, RT_HOME: rtHome }),
    addLabel: (issue, label) => ghRun(['issue', 'edit', String(issue), '-R', repo, '--add-label', label]),
    removeLabel: (issue, label) => ghRun(['issue', 'edit', String(issue), '-R', repo, '--remove-label', label]),
    pullRequest: async (pr) => {
      const live = JSON.parse(ghRun(['pr', 'view', String(pr), '-R', repo, '--json', 'files,labels']));
      return { files: live.files.map((file) => file.path), labels: live.labels.map((label) => label.name) };
    },
    listComments: async (issue) => JSON.parse(ghRun(['issue', 'view', String(issue), '-R', repo, '--json', 'comments'])).comments,
    createComment: (issue, body) => ghRun(['issue', 'comment', String(issue), '-R', repo, '--body-file', '-'], body),
  };
}

export function hostProvider(writer, im) {
  const notify = withIm(createGitHubOutboxProvider({ writer }), im);
  return {
    deliver(item) {
      if (item.kind === 'merge') {
        const { op, pr, head, mergeSha } = item.payload;
        if (op === 'squash') writer.squashMerge(pr, head, item.issue);
        else writer.revertMerge(mergeSha);
        return { ok: true };
      }
      if (item.kind === 'label' && item.payload.op === 'rm') {
        writer.removeLabel(item.issue, item.payload.label);
        return { ok: true };
      }
      return notify.deliver(item);
    },
  };
}

// Enqueue one item, then deliver it unless it already has a receipt or was dead-lettered. Returns whether it has a receipt.
export async function submit({ root, writer, item, send = fetchTransport, env }) {
  const outbox = openOutbox(root);
  outbox.enqueue(item);
  if (outbox.pending().every((i) => i.id !== item.id)) return outbox.receipts().has(item.id);
  try {
    outbox.markDelivered(item.id, await hostProvider(writer, loadImRouter({ root, send, env })).deliver({ ...item }));
    return true;
  } catch (error) {
    outbox.recordFailure(item.id, error.message, Date.now());
    outbox.markDead(item.id);
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, repo, op, issue, a, b, c] = process.argv.slice(2);
  const writer = ghWriter({ gh: process.env.RT_GH_REAL || '/usr/bin/gh', repo, rtHome: root });
  if (op === 'merge' || op === 'rollback') {
    const cause = { issue: Number(issue) || null, pr: Number(a), head: b, mergeSha: c };
    if (op === 'merge') {
      const refusal = await hostMergeRefusal({ readLive: () => writer.pullRequest(cause.pr), evidence: { highRisk: c === '1' }, revertOf: b.startsWith('rt/revert-') ? b : undefined });
      if (refusal) {
        process.stderr.write(`REFUSE[tier]: ${refusal}\n`);
        process.exitCode = 2;
      } else {
        const delivered = await submit({ root, writer, item: mergeItem(cause) });
        if (delivered && cause.issue) await submit({ root, writer, item: mergedNotice(cause) });
        process.exitCode = delivered ? 0 : 1;
      }
    } else {
      // requestRollback enqueues once; submit then delivers that same pending item.
      const requested = requestRollback(root, cause).ok;
      process.exitCode = requested && (await submit({ root, writer, item: rollbackItem(cause) })) ? 0 : 1;
    }
  } else {
    const item = op === 'comment' ? commentItem(Number(issue), readFileSync(a === '-' ? 0 : a, 'utf8')) : labelItem(Number(issue), a, b);
    process.exitCode = (await submit({ root, writer, item })) ? 0 : 1;
  }
}
