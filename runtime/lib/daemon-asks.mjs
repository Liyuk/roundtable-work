// RT-S9b: an ask is decided by policy before it can suspend its line (docs/self-supervision.md, section (d)). A resolve
// runs as a `decision` action through the action journal; a block or an approve-first tier returns `route` so that the
// caller sends the card to routeCard.
import { createHash, randomUUID } from 'node:crypto';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAsk } from './ask-policy.mjs';
import { autonomyTier } from './autonomy.mjs';
import { readLine } from './decision-cards.mjs';
import { openOutbox } from './outbox.mjs';

export const askHash = (question) => createHash('sha256').update(question).digest('hex').slice(0, 16);
const lineFile = (issue) => `.roundtable/state/lines/${issue}.json`;

/** Decides one ask by policy. Returns `resolved` when the line continues, or `route` when routeCard must decide. */
export async function decideByPolicy({ root, card, policy, now = Date.now }) {
  const verdict = resolveAsk({ card });
  if (verdict.outcome !== 'resolve') return 'route';
  const { issue, question } = card;
  const { journal, autonomy, ledger } = policy;
  const choice = verdict.choice ?? verdict.resolution;
  const action = { kind: 'decision', issue, key: askHash(question), category: card.category, labels: [], paths: [], plan: verdict, before: { file: lineFile(issue) } };
  const { tier, reasons } = autonomyTier(action, autonomy);
  if (tier === 'approve-first') return 'route';

  const apply = async () => {
    const line = await readLine(root, issue);
    line.decisions.push({ question, choice, reason: verdict.rule, source: 'policy', at: now() });
    Object.assign(line, { status: 'running', slot: 'worker', pending: null });
    const file = join(root, lineFile(issue));
    const tmp = `${file}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(line, null, 2) + '\n');
    await rename(tmp, file);
  };
  const notify = (notice) => openOutbox(root).enqueue({ id: notice.id, kind: 'notification', issue, payload: { subtype: notice.subtype, actionId: notice.actionId, state: notice.state } });
  const { id, state } = await journal.perform({ action: { ...action, reasons }, tier, apply, notify });
  if (state === 'rolled_back') return 'route';
  ledger.append({ category: 'decision', ref: `#${issue}`, reason: `ask resolved by policy: ${verdict.rule}`, internalized: 'no', source: 'self' }, { key: id });
  return 'resolved';
}
