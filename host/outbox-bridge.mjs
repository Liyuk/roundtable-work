// Host bridge (host-side glue, so it may run gh; runtime/ stays free of subprocesses): rt-work.sh and rt-sched.py send their comments, label add/remove and notifications through the durable outbox.
// Each call enqueues one item (before its gh call), then delivers only that item with the real gh.
// A failed item is recorded and dead-lettered, never retried, so a stale write cannot land after a later one. Exit 0 only when this call's item was delivered.
//   node host/outbox-bridge.mjs <root> <repo> comment <issue> <bodyFile|->   (body from stdin when "-")
//   node host/outbox-bridge.mjs <root> <repo> label <issue> add|rm <label>
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGitHubOutboxProvider } from '../runtime/lib/outbox-github.mjs';
import { openOutbox } from '../runtime/lib/outbox.mjs';

// Comment ids derive from the body, so a replayed identical comment is refused by enqueue. Accepted trade-off: identical text on the same issue is posted once.
export const commentItem = (issue, body) => ({ id: `comment:${issue}:${createHash('sha256').update(body).digest('hex').slice(0, 16)}`, kind: 'comment', issue, payload: { body } });

// Label ids are unique per write, so an add, remove, add cycle is three distinct writes.
export function labelItem(issue, op, label) {
  if (op !== 'add' && op !== 'rm') throw new TypeError(`label op must be add or rm: ${op}`);
  return { id: `label:${issue}:${op}:${label}:${randomUUID()}`, kind: 'label', issue, payload: { op, label } };
}

// The gh writer runs the real CLI with an argument array (no shell). gh's stderr is passed through on failure.
export function ghWriter({ gh, repo }) {
  const run = (args, input) => {
    const r = spawnSync(gh, args, { encoding: 'utf8', input });
    if (r.status !== 0) {
      process.stderr.write(r.stderr);
      throw new Error(r.stderr.trim().slice(0, 200));
    }
    return r.stdout;
  };
  return {
    addLabel: (issue, label) => run(['issue', 'edit', String(issue), '-R', repo, '--add-label', label]),
    removeLabel: (issue, label) => run(['issue', 'edit', String(issue), '-R', repo, '--remove-label', label]),
    listComments: async (issue) => JSON.parse(run(['issue', 'view', String(issue), '-R', repo, '--json', 'comments'])).comments,
    createComment: (issue, body) => run(['issue', 'comment', String(issue), '-R', repo, '--body-file', '-'], body),
  };
}

export function hostProvider(writer) {
  const github = createGitHubOutboxProvider({ writer });
  return {
    deliver(item) {
      if (item.kind === 'label' && item.payload.op === 'rm') {
        writer.removeLabel(item.issue, item.payload.label);
        return { ok: true };
      }
      return github.deliver(item);
    },
  };
}

// Enqueue one item, then deliver it unless it already has a receipt or was dead-lettered. Returns whether it has a receipt.
export async function submit({ root, writer, item }) {
  const outbox = openOutbox(root);
  outbox.enqueue(item);
  if (outbox.pending().every((i) => i.id !== item.id)) return outbox.receipts().has(item.id);
  try {
    outbox.markDelivered(item.id, await hostProvider(writer).deliver({ ...item }));
    return true;
  } catch (error) {
    outbox.recordFailure(item.id, error.message, Date.now());
    outbox.markDead(item.id);
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [root, repo, op, issue, a, b] = process.argv.slice(2);
  const item = op === 'comment' ? commentItem(Number(issue), readFileSync(a === '-' ? 0 : a, 'utf8')) : labelItem(Number(issue), a, b);
  const gh = process.env.RT_GH_REAL || '/usr/bin/gh';
  process.exitCode = (await submit({ root, writer: ghWriter({ gh, repo }), item })) ? 0 : 1;
}
