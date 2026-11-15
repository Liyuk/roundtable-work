// RT-S13d: one record per (route, issue, key) of an ask, `route` being `supervisor` (decided by policy or the timeout default)
// or `owner` (routed to the owner). The question text is not stored. metrics.mjs counts supervisor-held asks and owner
// interruptions from this ledger.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ASK_LEDGER_PATH = '.roundtable/state/ask-ledger.jsonl';

/** Appends one ask route under `<root>`, once per (route, issue, key). */
export function recordAsk(root, { issue, key, route, at }) {
  const file = join(root, ASK_LEDGER_PATH);
  const seen = existsSync(file) && readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  if (seen && seen.some((r) => r.route === route && r.issue === issue && r.key === key)) return;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ issue, key, route, at }) + '\n');
}
