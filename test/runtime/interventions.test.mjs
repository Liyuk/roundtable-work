import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInterventions } from '../../runtime/lib/interventions.mjs';

const CLI = join(import.meta.dirname, '../../scripts/rt-intervention.mjs');
const base = {
  category: 'decision',
  ref: '#417',
  reason: 'Owner asked for a decision',
  internalized: 'no',
  source: 'external',
  at: '2026-11-15T09:00:00Z',
};
const withRoot = async fn => {
  const root = await mkdtemp(join(tmpdir(), 'rt-interventions-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
};
const ledgerFile = root => join(root, '.roundtable', 'state', 'interventions.jsonl');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

test('append writes one v1 JSON line with the required fields under .roundtable/state', () => withRoot(async root => {
  const ledger = openInterventions(root);
  const { id } = ledger.append({ ...base, kind: 'pause', followUp: 'check later' }, { key: 'k1' });
  const lines = (await readFile(ledgerFile(root), 'utf8')).trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { v: 1, id, ...base, kind: 'pause', followUp: 'check later' });
  assert.equal(ledger.entries().entries.length, 1);
  assert.deepEqual(ledger.entries().skipped, []);
}));

test('optional kind and followUp are omitted when absent', () => withRoot(async root => {
  openInterventions(root).append(base, { key: 'k1' });
  const [line] = (await readFile(ledgerFile(root), 'utf8')).trimEnd().split('\n');
  assert.equal(Object.hasOwn(JSON.parse(line), 'kind'), false);
  assert.equal(Object.hasOwn(JSON.parse(line), 'followUp'), false);
}));

test('bad enumerated or shape fields throw a TypeError naming the field', () => withRoot(async root => {
  const ledger = openInterventions(root);
  const bad = [
    ['category', { category: 'bogus' }],
    ['internalized', { internalized: 'maybe' }],
    ['source', { source: 'bot' }],
    ['kind', { kind: 'stop' }],
    ['ref', { ref: 'issue 4' }],
    ['ref', { ref: '#abc' }],
    ['at', { at: '2026-11-15' }],
    ['followUp', { followUp: 5 }],
  ];
  for (const [field, patch] of bad) {
    assert.throws(() => ledger.append({ ...base, ...patch }, { key: 'k' }), err => err instanceof TypeError && err.message.includes(field), field);
  }
  assert.equal(existsSync(ledgerFile(root)), false);
}));

test('every allowed enumerated and ref value is accepted', () => withRoot(async root => {
  const ledger = openInterventions(root);
  const categories = ['liveness', 'self-repair', 'resource', 'decision', 'merge', 'backlog', 'self-review', 'reporting', 'owner-only'];
  for (const category of categories) ledger.append({ ...base, category }, { key: category });
  for (const internalized of ['yes', 'partial', 'no']) ledger.append({ ...base, internalized }, { key: internalized });
  for (const source of ['owner', 'external', 'self']) ledger.append({ ...base, source }, { key: source });
  for (const kind of ['pause', 'resume']) ledger.append({ ...base, kind }, { key: kind });
  for (const ref of ['#7', 'patch:abc-1', 'rt:status', 'none']) ledger.append({ ...base, ref }, { key: ref });
  assert.equal(ledger.entries().entries.length, categories.length + 3 + 3 + 2 + 4);
}));

test('reason must be one line; over-long reasons are cut on a code-point boundary', () => withRoot(async root => {
  const ledger = openInterventions(root);
  assert.throws(() => ledger.append({ ...base, reason: 'two\nlines' }, { key: 'k' }), /reason/);
  assert.throws(() => ledger.append({ ...base, reason: 'tab\there' }, { key: 'k' }), /reason/);
  ledger.append({ ...base, reason: '😀'.repeat(301) }, { key: 'long' });
  const [entry] = ledger.entries().entries;
  assert.equal(Array.from(entry.reason).length, 300);
  assert.equal(entry.reason, '😀'.repeat(300));
}));

test('reasons with a home path, IPv4 address, or credential-like token are rejected', () => withRoot(async root => {
  const ledger = openInterventions(root);
  const sensitive = [
    ['see', '', 'home', 'placeholder', 'work'].join('/'),
    ['see', '', 'Users', 'placeholder', 'work'].join('/'),
    'see /root/work',
    'see ~/work',
    'host at 192.0.2.10 failed',
    'password=hunter2',
    'token=abc123',
    'secret=xyz',
    'ghp_' + 'a'.repeat(36),
    'key sk-abcdefghijklmnop',
    'AKIAIOSFODNN7EXAMPLE',
  ];
  for (const reason of sensitive) {
    assert.throws(() => ledger.append({ ...base, reason }, { key: 'k' }), err => err instanceof TypeError && err.message.includes('reason'), reason);
  }
  assert.equal(existsSync(ledgerFile(root)), false);
  ledger.append({ ...base, reason: 'task-1 finished with 2 retries' }, { key: 'ok' });
  assert.equal(ledger.entries().entries.length, 1);
}));

test('id is iv: plus 16 hex of sha256 over the JSON tuple, and a repeated append writes one line', () => withRoot(async root => {
  const ledger = openInterventions(root);
  const expected = 'iv:' + createHash('sha256').update(JSON.stringify(['external', 'decision', '#417', 'k1'])).digest('hex').slice(0, 16);
  assert.equal(ledger.append(base, { key: 'k1' }).id, expected);
  assert.equal(ledger.append({ ...base, reason: 'a different reason' }, { key: 'k1' }).id, expected);
  assert.equal(ledger.entries().entries.length, 1);
  assert.notEqual(ledger.append(base, { key: 'k2' }).id, expected);
  assert.equal(ledger.entries().entries.length, 2);
}));

test('invalid JSON lines, including one cut inside a multi-byte sequence, are skipped and reported', () => withRoot(async root => {
  const ledger = openInterventions(root);
  ledger.append(base, { key: 'k1' });
  const cut = Buffer.from('{"v":1,"reason":"café"', 'utf8');
  const partial = cut.subarray(0, cut.indexOf(Buffer.from('é')) + 1);
  appendFileSync(ledgerFile(root), 'not json\n');
  appendFileSync(ledgerFile(root), partial);
  const result = ledger.entries();
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.skipped, [2, 3]);
}));

test('view returns the latest internalized value per ref', () => withRoot(async root => {
  const ledger = openInterventions(root);
  ledger.append({ ...base, ref: '#1', internalized: 'no' }, { key: 'a' });
  ledger.append({ ...base, ref: '#2', internalized: 'partial' }, { key: 'b' });
  ledger.append({ ...base, ref: '#1', internalized: 'yes' }, { key: 'c' });
  assert.deepEqual(ledger.view(), { '#1': 'yes', '#2': 'partial' });
}));

test('CLI add prints the id and list --json prints the entry', () => withRoot(async root => {
  const added = cli('add', '--workspace', root, '--category', 'merge', '--ref', '#417', '--reason', 'Merged by owner', '--internalized', 'no', '--source', 'external', '--key', 'cli-1');
  assert.equal(added.status, 0, added.stderr);
  const { id } = JSON.parse(added.stdout);
  assert.equal(id, openInterventions(root).entries().entries[0].id);
  const listed = cli('list', '--workspace', root, '--json');
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(JSON.parse(listed.stdout)[0].reason, 'Merged by owner');
}));

test('CLI add without --key uses the entry at timestamp as key', () => withRoot(async root => {
  const added = cli('add', '--workspace', root, '--category', 'merge', '--ref', 'none', '--reason', 'Timed', '--internalized', 'yes', '--source', 'self');
  assert.equal(added.status, 0, added.stderr);
  const [entry] = openInterventions(root).entries().entries;
  const expected = 'iv:' + createHash('sha256').update(JSON.stringify(['self', 'merge', 'none', entry.at])).digest('hex').slice(0, 16);
  assert.equal(entry.id, expected);
}));

test('CLI import reads a 3-row TSV once and a second import adds nothing', () => withRoot(async root => {
  const tsv = join(root, 'interventions.tsv');
  await writeFile(tsv, [
    'time\tcategory\tref\treason\tinternalized',
    '2026-11-15T01:00:00Z\tliveness\t#10\tWorker stalled\tyes',
    '2026-11-15T02:00:00Z\tresource\tpatch:quota\tBudget exceeded\tpartial',
    '2026-11-15T03:00:00Z\treporting\trt:status\tStatus unclear\tno',
    '',
  ].join('\n'));
  const first = cli('import', '--workspace', root, '--tsv', tsv);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout), { added: 3 });
  const rows = openInterventions(root).entries().entries;
  assert.deepEqual(rows.map(r => [r.at, r.source, r.ref]), [
    ['2026-11-15T01:00:00Z', 'external', '#10'],
    ['2026-11-15T02:00:00Z', 'external', 'patch:quota'],
    ['2026-11-15T03:00:00Z', 'external', 'rt:status'],
  ]);
  const second = cli('import', '--workspace', root, '--tsv', tsv);
  assert.deepEqual(JSON.parse(second.stdout), { added: 0 });
  assert.equal(openInterventions(root).entries().entries.length, 3);
}));
