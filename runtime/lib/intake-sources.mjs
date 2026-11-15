// Intake source plugins: each configured adapter yields reports, which are normalized, filtered, and accepted into the event inbox.
// Adapter contract: a module default-exports { poll(since), parse(payload) }, each returning an array of raw reports.
// The contract has no write method; the runner keeps only poll and parse.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openInbox } from './event-inbox.mjs';

export const CONFIG_PATH = 'runtime/intake-sources.config.json';

// Keeps only public handles and links; private fields in raw reports are dropped.
export function normalizeReport(raw, source) {
  return { source, url: raw.url, author: raw.author, text: raw.text, time: raw.time, source_event_id: raw.source_event_id };
}

export function matchesFilter(report, keywords = []) {
  const text = report.text.toLowerCase();
  return keywords.length === 0 || keywords.some((k) => text.includes(k.toLowerCase()));
}

export function loadConfig(root) {
  return JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf8')).sources;
}

export async function loadAdapter(root, modulePath) {
  const mod = (await import(pathToFileURL(resolve(root, modulePath)).href)).default;
  return { poll: (since) => mod.poll(since), parse: (payload) => mod.parse(payload) };
}

export async function pollIntake(root, { since, receivedAt = Date.now() } = {}) {
  const inbox = openInbox(root);
  let accepted = 0;
  for (const source of loadConfig(root)) {
    const adapter = await loadAdapter(root, source.module);
    for (const raw of await adapter.poll(since)) {
      const report = normalizeReport(raw, source.name);
      if (!matchesFilter(report, source.keywords)) continue;
      const event = { source_event_id: report.source_event_id, kind: 'intake', issue: source.issue ?? null, payload: report, receivedAt };
      if (inbox.accept(event)) accepted++;
    }
  }
  return accepted;
}
