// Decision cards in the daemon cycle: an ask becomes a card, a closed-category card suspends only its line and enqueues one
// approval request, and an owner approve/reject reply resumes the suspended line. The daemon has no card provider, so a
// non-closed card fails closed (the default provider throws) and suspends too.
import { readLine, resumeFromApproval, routeCard } from './decision-cards.mjs';
import { askHash, decideByPolicy } from './daemon-asks.mjs';
import { recordOwnerAnswer, stampSuspension } from './ask-timeout.mjs';
import { openOutbox } from './outbox.mjs';
import { recordAsk } from './ask-ledger.mjs';

export const cardProvider = { decide: async () => { throw new Error('no card provider configured'); } };

/** The owner is the login of the repo owner segment; without a repo there is no owner. */
export const ownerOf = (repo) => repo?.split('/')[0];

// processPending already guarantees at-most-once dispatch per source_event_id (claim and applied markers), so the
// approval inbox only has to accept the event.
const approvalInbox = { accept: () => true };

/**
 * Routes one ask. With a `policy`, a resolvable ask is decided first and the line continues (`resolved`). Otherwise it
 * is routed as a card: a suspended card enqueues one approval request; the same question yields one item.
 */
export async function dispatchAsk({ root, issue, category, question, evidence, options = ['approve', 'reject'], recommendation = 'reject', scopeKind, provider = cardProvider, policy, now = Date.now }) {
  const card = {
    issue, category, question, options, recommendation,
    evidence: evidence?.length ? evidence : [`issue #${issue} DECISION=ask`],
  };
  // scopeKind is read by the policy only: the routed card schema (routeCard) does not carry it.
  if (policy && await decideByPolicy({ root, card: { ...card, scopeKind }, policy }) === 'resolved') return { status: 'resolved' };
  const { pending: prior } = await readLine(root, issue);
  const result = await routeCard({ root, card, provider });
  if (result.status === 'suspended') {
    await stampSuspension({ root, issue, scopeKind, now, since: prior?.question === question ? prior.at : undefined });
    recordAsk(root, { issue, key: askHash(question), route: 'owner', at: now() });
    openOutbox(root).enqueue({ id: `notice:card:${issue}:${askHash(question)}`, kind: 'notification', issue, payload: { subtype: 'approval-request', ...card } });
  }
  return result;
}

/**
 * The `dispatchLine(batch)` for the cycle. `decisionOf(issue)` returns `{ category, question, evidence }` for an ask or
 * undefined. Owner decisions resume only when the comment author is the owner. An amend comment resumes the line's
 * session through `resume({ root, issue, sessionId, text, actionId })`; the default resume does nothing.
 */
export function makeDispatchLine({ root, owner, decisionOf = () => undefined, provider, policy, resume = async () => {} }) {
  return async (batch) => {
    console.error(JSON.stringify({ event: 'dispatch_line', issue: batch.issue, kinds: batch.events.map((e) => e.kind) }));
    const ask = decisionOf(batch.issue);
    if (ask) await dispatchAsk({ root, issue: batch.issue, provider, policy, ...ask });
    for (const event of batch.events) {
      if (event.kind === 'owner_comment' && event.payload.command === 'amend') {
        const { sessionId, text, actionId } = event.payload;
        await resume({ root, issue: batch.issue, sessionId, text, actionId });
      }
      if (event.kind === 'owner_comment' && event.payload.decision && owner && event.payload.author === owner) {
        const { pending } = await readLine(root, batch.issue);
        if ((await resumeFromApproval({ root, inbox: approvalInbox, event })).status === 'resumed') {
          recordOwnerAnswer({ root, category: pending.category, question: pending.question });
        }
      }
    }
  };
}
