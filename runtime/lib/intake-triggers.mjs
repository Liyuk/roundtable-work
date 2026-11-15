// Intake triggers: poll and signed webhook both feed the same normalize → filter → event inbox path as pollIntake.
// No outbound requests: this module never sends anything to a source.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { loadAdapter, loadConfig, matchesFilter, normalizeReport, pollIntake } from './intake-sources.mjs';
import { openInbox } from './event-inbox.mjs';

const SIGNATURE = /^sha256=[0-9a-f]{64}$/;

export function schedulePoll(root, { since, receivedAt = Date.now() } = {}) {
  return pollIntake(root, { since, receivedAt });
}

export function verifySignature(rawBody, signatureHeader, secret) {
  if (typeof signatureHeader !== 'string' || !SIGNATURE.test(signatureHeader)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(signatureHeader.slice('sha256='.length), 'hex'));
}

export async function webhookIngest(root, { source: name, secret, rawBody, signatureHeader, receivedAt = Date.now() }) {
  if (!verifySignature(rawBody, signatureHeader, secret)) return { accepted: 0, rejected: 'bad_signature' };
  const source = loadConfig(root).find((s) => s.name === name);
  if (!source) return { accepted: 0, rejected: 'unknown_source' };
  const adapter = await loadAdapter(root, source.module);
  const inbox = openInbox(root);
  let accepted = 0;
  for (const raw of adapter.parse(JSON.parse(rawBody.toString()))) {
    const report = normalizeReport(raw, source.name);
    if (!matchesFilter(report, source.keywords)) continue;
    const event = { source_event_id: report.source_event_id, kind: 'intake', issue: source.issue ?? null, payload: report, receivedAt };
    if (inbox.accept(event)) accepted++;
  }
  return { accepted };
}
