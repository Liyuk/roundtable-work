import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const CATEGORIES = ['liveness', 'self-repair', 'resource', 'decision', 'merge', 'backlog', 'self-review', 'reporting', 'owner-only'];
const INTERNALIZED = ['yes', 'partial', 'no'];
const SOURCES = ['owner', 'external', 'self'];
const KINDS = ['pause', 'resume'];
const REF = /^(?:#\d+|patch:\S+|rt:\S+|none)$/;
const AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ONE_LINE = /^[^\x00-\x1f\x7f]+$/;
const SENSITIVE = [
  /\/home\/|\/Users\/|\/root\/|~\//,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /(?:password|token|secret)=/i,
  /gh[pousr]_[A-Za-z0-9]/,
  /\bsk-[A-Za-z0-9]/,
  /AKIA[0-9A-Z]{8,}/,
];
const REASON_MAX = 300;

/** Open the append-only intervention ledger under `<root>/.roundtable/state/interventions.jsonl`. */
export function openInterventions(root) {
  const file = join(root, '.roundtable', 'state', 'interventions.jsonl');
  const read = () => {
    if (!existsSync(file)) return { entries: [], skipped: [] };
    const entries = [];
    const skipped = [];
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (line === '') return;
      try { entries.push(JSON.parse(line)); } catch { skipped.push(index + 1); }
    });
    return { entries, skipped };
  };
  return {
    append(entry, { key } = {}) {
      const record = toRecord(entry, key);
      if (read().entries.some(existing => existing.id === record.id)) return { id: record.id, added: false };
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify(record) + '\n');
      return { id: record.id, added: true };
    },
    entries: read,
    view() {
      const latest = {};
      for (const entry of read().entries) latest[entry.ref] = entry.internalized;
      return latest;
    },
  };
}

function toRecord(entry, key) {
  if (typeof key !== 'string' || key === '') throw new TypeError('key must be a non-empty string');
  const at = entry.at ?? new Date().toISOString();
  if (typeof at !== 'string' || !AT.test(at)) throw new TypeError('at must be an ISO UTC timestamp');
  oneOf('category', entry.category, CATEGORIES);
  if (typeof entry.ref !== 'string' || !REF.test(entry.ref)) throw new TypeError('ref must be #<n>, patch:<tag>, rt:<command>, or none');
  if (typeof entry.reason !== 'string' || !ONE_LINE.test(entry.reason)) throw new TypeError('reason must be one line of text');
  if (SENSITIVE.some(pattern => pattern.test(entry.reason))) throw new TypeError('reason contains a path, address, or credential-like token');
  oneOf('internalized', entry.internalized, INTERNALIZED);
  oneOf('source', entry.source, SOURCES);
  if (entry.kind !== undefined) oneOf('kind', entry.kind, KINDS);
  if (entry.followUp !== undefined && typeof entry.followUp !== 'string') throw new TypeError('followUp must be a string');
  const id = 'iv:' + createHash('sha256').update(JSON.stringify([entry.source, entry.category, entry.ref, key])).digest('hex').slice(0, 16);
  return {
    v: 1,
    id,
    at,
    category: entry.category,
    ref: entry.ref,
    reason: Array.from(entry.reason).slice(0, REASON_MAX).join(''),
    internalized: entry.internalized,
    source: entry.source,
    kind: entry.kind,
    followUp: entry.followUp,
  };
}

function oneOf(field, value, allowed) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
}
