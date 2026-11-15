#!/usr/bin/env node
// Host patch recorder (RT-S10, docs/self-supervision.md "(f) Host patch to tested rule").
// `record` appends a self-repair ledger entry (internalized: no) and files a T2 follow-up through the filer's path;
// `mark-internalized` appends the internalized: yes entry once the follow-up merges.
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openInterventions } from '../runtime/lib/interventions.mjs';
import { fileFollowUp } from '../runtime/lib/self-review-filer.mjs';

const option = { type: 'string' };
const NO_CLIENT = 'follow-up not filed: no tracker client is wired into this command';
const ref = (tag) => `patch:${tag}`;

// `--files` takes base names only: a directory part or a home path is refused at the boundary.
function namesOf(files) {
  const names = files.split(',');
  if (names.some((name) => /[/\\~]/.test(name))) throw new TypeError('--files takes base file names only; no directory part or home path');
  return names;
}

// `--diffstat` is `git diff --numstat` output (added, deleted, path). Returns [name, changed lines] per named file.
function changesOf(names, diffstat) {
  if (!diffstat) return names.map((name) => [name, undefined]);
  const counts = new Map();
  for (const line of readFileSync(diffstat, 'utf8').split('\n')) {
    const [added, deleted, path] = line.split('\t');
    if (path) counts.set(basename(path), Number(added) + Number(deleted));
  }
  return names.map((name) => [name, counts.get(name)]);
}

/** Appends the self-repair entry; with a tracker client, also files the follow-up. */
export async function recordPatch({ workspace, tag, files, summary, diffstat, source = 'external', now = new Date(), client, hygiene }) {
  if (!['owner', 'external'].includes(source)) throw new TypeError('source must be owner or external');
  const names = namesOf(files);
  const ledger = openInterventions(workspace).append({ at: now.toISOString(), category: 'self-repair', ref: ref(tag), reason: summary, internalized: 'no', source }, { key: `record:${tag}` });
  if (!client) return { ledger, follow: { outcome: 'not-filed', reason: 'no tracker client' } };

  const changes = changesOf(names, diffstat);
  const measured = changes.every(([, n]) => n !== undefined);
  const lines = measured ? changes.reduce((sum, [, n]) => sum + n, 0) : undefined;
  const body = [
    '## Goal', `Port host patch ${tag} to a tested rule: ${summary}`, '',
    '## Acceptance criteria', '- Run: `npm test && npm run check`; Expected: a regression test named in the inventory row fails without the port and passes with it', '',
    '## Out of scope', 'Changes beyond the files listed below.', '',
    '## Dependencies', 'None.', '',
    '## Size estimate', `Changed lines: ${lines ?? 'not measured'}`, `Files: ${names.length}`, '',
    '## Touch set', ...changes.map(([name, n]) => (n === undefined ? `- ${name}` : `- ${name}: ${n} changed lines`)),
  ].join('\n');
  const follow = await fileFollowUp({ client, hygiene, fingerprint: `T2:${tag}`, title: `Host patch not internalized: ${ref(tag)}`, body, touchSet: names, lines });
  return { ledger, follow };
}

/** Appends internalized: yes for the recorded patch, keeping its source; the key differs from the record's key. */
export function markInternalized({ workspace, tag, issue, now = new Date() }) {
  if (!/^\d+$/.test(issue)) throw new TypeError('issue must be a number');
  const ledger = openInterventions(workspace);
  const original = ledger.entries().entries.find((e) => e.ref === ref(tag) && e.category === 'self-repair' && e.internalized === 'no');
  if (!original) throw new TypeError(`no self-repair record for ${ref(tag)}`);
  return ledger.append({ at: now.toISOString(), category: 'self-repair', ref: ref(tag), reason: `Internalized by #${issue}`, internalized: 'yes', source: original.source, followUp: `#${issue}` }, { key: `internalized:${tag}` });
}

async function main(argv) {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true,
    options: { workspace: option, tag: option, files: option, summary: option, diffstat: option, source: option, issue: option },
  });
  const [command] = positionals;
  if (command === 'record') {
    const { ledger, follow } = await recordPatch({ workspace: values.workspace, tag: values.tag, files: values.files, summary: values.summary, diffstat: values.diffstat, source: values.source });
    console.log(JSON.stringify({ id: ledger.id, added: ledger.added, follow }));
    if (follow.outcome === 'not-filed') console.log(NO_CLIENT);
  } else if (command === 'mark-internalized') {
    const { id, added } = markInternalized({ workspace: values.workspace, tag: values.tag, issue: values.issue });
    console.log(JSON.stringify({ id, added }));
  } else {
    throw new TypeError('usage: rt-host-patch.mjs record|mark-internalized --workspace DIR --tag T ...');
  }
}

const invoked = (() => {
  try { return process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invoked) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
