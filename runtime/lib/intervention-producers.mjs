// Pure classification of owner GitHub comments into intervention ledger entries (RT-S2, #418). No I/O.
import { parseRtCommand } from './rt-commands.mjs';
import { isTerminal } from './queue.mjs';
import { deriveLabelState } from './label-projection.mjs';

export const DEFAULT_EXTERNAL_PREFIXES = Object.freeze(['Owner-delegated', 'Owner decision', 'Owner: additional acceptance', 'Superseded by']);

const LIVENESS_KIND = { pause: 'pause', resume: 'resume' };

/** Returns a ledger entry `{ category, source, kind? }` for an owner comment, or null when it is not an intervention. */
export function classifyOwnerEvent({ event, line, owner, externalPrefixes = DEFAULT_EXTERNAL_PREFIXES }) {
  const body = event.payload.body;
  // Internal owner_comment events (e.g. amend requests) carry no body: they are not comments.
  if (event.kind !== 'owner_comment' || event.payload.author !== owner || typeof body !== 'string') return null;
  const source = externalPrefixes.some((prefix) => body.startsWith(prefix)) ? 'external' : 'owner';
  const cmd = parseRtCommand(body);
  if (cmd.ok) {
    if (cmd.command in LIVENESS_KIND) return { category: 'liveness', source, kind: LIVENESS_KIND[cmd.command] };
    if (cmd.command === 'requeue') return { category: 'merge', source };
    return null;
  }
  if (line.pause?.kind === 'ask') return { category: 'decision', source };
  if (line.labels?.includes('rt:blocked')) return { category: 'merge', source };
  if (isTerminal(line.status)) return { category: 'self-review', source };
  if (/\bacceptance\b/i.test(body)) return { category: 'backlog', source };
  return null;
}

/** The line shape `classifyOwnerEvent` reads, derived from the line's stored state (labels follow `deriveLabelState`). */
export const lineOf = (state) => ({ status: state.status, pause: state.pause ?? null, labels: deriveLabelState({ issue: { state: 'open', labels: [] }, state }) });

/** Classifies one owner_comment event and appends it to the ledger under its source event id (re-appending is a no-op). */
export function recordOwnerEvent({ ledger, event, state, owner }) {
  const entry = classifyOwnerEvent({ event, line: lineOf(state), owner });
  if (entry) ledger.append({ ...entry, ref: `#${event.issue}`, reason: `owner comment classified as ${entry.category}`, internalized: 'no' }, { key: event.source_event_id });
}
