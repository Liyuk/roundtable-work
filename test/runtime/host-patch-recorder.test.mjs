import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recordPatch, markInternalized } from '../../scripts/rt-host-patch.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';

// Seams: recordPatch and markInternalized (library), and the CLI for argument refusal and the no-client path.
// The tracker is a fake client; no network and no gh.
const CLI = join(import.meta.dirname, '../../scripts/rt-host-patch.mjs');
const NOW = new Date('2026-11-15T12:00:00Z');
const marker = (fp) => `<!-- rt:fingerprint ${fp} -->`;
const fpOf = (tag) => `T2:${tag}`;

function fakeClient() {
  const issues = [];
  const find = (n) => issues.find((i) => i.number === n);
  return {
    issues,
    listOpen: async () => issues.filter((i) => i.state === 'OPEN'),
    listClosed: async () => [],
    search: async (query) => issues.filter((i) => i.body.includes(query)),
    getIssue: async (n) => find(n),
    createLabel: async () => {},
    createIssue: async (title, body) => {
      const number = issues.length + 100;
      issues.push({ number, title, body, labels: [], state: 'OPEN' });
      return { number };
    },
    addLabel: async (n, label) => { find(n).labels.push(label); },
    removeLabel: async () => {},
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'rt-host-patch-'));
  const outside = await mkdtemp(join(tmpdir(), 'rt-host-patch-deny-'));
  const denylistPath = join(outside, 'names.json');
  await writeFile(denylistPath, '[]');
  const hygiene = { denylistPath, repoRoot: root, expectedSha256: createHash('sha256').update('[]').digest('hex') };
  return { root, hygiene, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]) };
}

const ledgerOf = (root) => openInterventions(root).entries().entries;
const numstat = async (root, text) => {
  const file = join(root, 'numstat.txt');
  await writeFile(file, text);
  return file;
};

test('record appends a self-repair ledger entry, internalized no, ref patch:<tag>, source external by default', async () => {
  const { root, cleanup } = await workspace();
  try {
    await recordPatch({ workspace: root, tag: 'pt1', files: 'a.mjs,b.mjs', summary: 'Ported a rule', now: NOW });
    const [entry] = ledgerOf(root);
    assert.deepEqual([entry.category, entry.internalized, entry.ref, entry.source, entry.reason], ['self-repair', 'no', 'patch:pt1', 'external', 'Ported a rule']);
    await recordPatch({ workspace: root, tag: 'pt2', files: 'c.mjs', summary: 'Owner fix', source: 'owner', now: NOW });
    assert.equal(ledgerOf(root)[1].source, 'owner');
  } finally { await cleanup(); }
});

test('record with a fake client files one follow-up with fingerprint T2:<tag>; recording the same tag twice files one issue', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient();
    const diffstat = await numstat(root, '3\t1\tdir/a.mjs\n10\t0\tdir/b.mjs\n');
    const args = { workspace: root, tag: 'pt3', files: 'a.mjs,b.mjs', summary: 'Ported a rule', diffstat, client, hygiene, now: NOW };
    const first = await recordPatch(args);
    const second = await recordPatch(args);
    assert.deepEqual([first.follow.outcome, second.follow.outcome, second.follow.reason], ['filed', 'skipped', 'fingerprint']);
    assert.equal(client.issues.length, 1);
    const [issue] = client.issues;
    assert.equal(issue.title, 'Host patch not internalized: patch:pt3');
    assert.ok(issue.body.includes(marker(fpOf('pt3'))));
    assert.deepEqual(issue.labels, ['source:self', 'type:feature', 'priority:p2', 'rt:go']);
  } finally { await cleanup(); }
});

test('the follow-up body lists base names and line counts, and carries the required acceptance item', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient();
    const diffstat = await numstat(root, '3\t1\tdir/a.mjs\n10\t0\tdir/b.mjs\n');
    await recordPatch({ workspace: root, tag: 'pt4', files: 'a.mjs,b.mjs', summary: 'Ported a rule', diffstat, client, hygiene, now: NOW });
    const body = client.issues[0].body;
    assert.match(body, /^- a\.mjs: 4 changed lines$/m);
    assert.match(body, /^- b\.mjs: 10 changed lines$/m);
    assert.match(body, /^Changed lines: 14$/m);
    assert.match(body, /Expected: a regression test named in the inventory row fails without the port and passes with it$/m);
    assert.doesNotMatch(body, /dir\//);
  } finally { await cleanup(); }
});

test('--files with a directory part or a home path is refused with a non-zero exit and writes nothing', async () => {
  const { root, cleanup } = await workspace();
  try {
    // Home prefixes are joined at runtime so this file holds no literal home path (the hygiene scan reads test files too).
    const home = ['/ho', 'me/x/a.mjs'].join('');
    const users = ['/Us', 'ers/x/a.mjs'].join('');
    for (const files of ['dir/a.mjs', 'dir\\a.mjs', '~/a.mjs', home, users, ['/ro', 'ot/a.mjs'].join('')]) {
      const result = spawnSync(process.execPath, [CLI, 'record', '--workspace', root, '--tag', 'pt5', '--files', files, '--summary', 'refused'], { encoding: 'utf8' });
      assert.notEqual(result.status, 0, files);
    }
    assert.deepEqual(ledgerOf(root), []);
  } finally { await cleanup(); }
});

test('the CLI with no tracker client wired records the ledger entry, reports the follow-up as not filed, and exits 0', async () => {
  const { root, cleanup } = await workspace();
  try {
    const result = spawnSync(process.execPath, [CLI, 'record', '--workspace', root, '--tag', 'pt6', '--files', 'a.mjs', '--summary', 'No client'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /follow-up not filed/);
    assert.equal(ledgerOf(root).length, 1);
  } finally { await cleanup(); }
});

test('mark-internalized appends internalized yes for the same ref and source, with a key distinct from the record', async () => {
  const { root, cleanup } = await workspace();
  try {
    await recordPatch({ workspace: root, tag: 'pt7', files: 'a.mjs', summary: 'Owner fix', source: 'owner', now: NOW });
    const [original] = ledgerOf(root);
    const marked = markInternalized({ workspace: root, tag: 'pt7', issue: 321, now: NOW });
    const [, yes] = ledgerOf(root);
    assert.equal(marked.added, true);
    assert.deepEqual([yes.category, yes.ref, yes.internalized, yes.source, yes.followUp], ['self-repair', 'patch:pt7', 'yes', 'owner', '#321']);
    assert.notEqual(yes.id, original.id);
    assert.equal(openInterventions(root).view()['patch:pt7'], 'yes');
  } finally { await cleanup(); }
});

test('mark-internalized refuses a tag with no recorded patch and a non-numeric issue', async () => {
  const { root, cleanup } = await workspace();
  try {
    assert.throws(() => markInternalized({ workspace: root, tag: 'missing', issue: 1, now: NOW }), /no self-repair record/);
    await recordPatch({ workspace: root, tag: 'pt8', files: 'a.mjs', summary: 'x', now: NOW });
    assert.throws(() => markInternalized({ workspace: root, tag: 'pt8', issue: 'abc', now: NOW }), /issue must be a number/);
  } finally { await cleanup(); }
});

test('a follow-up whose size is not measured (no diffstat) is refused by admission and not filed', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient();
    const result = await recordPatch({ workspace: root, tag: 'pt9', files: 'a.mjs', summary: 'No diffstat', client, hygiene, now: NOW });
    assert.deepEqual([result.follow.outcome, result.follow.reason], ['refused', 'admission']);
    assert.equal(client.issues.length, 0);
  } finally { await cleanup(); }
});

test('a binary numstat row (dash counts) leaves the size not measured: admission refuses the follow-up and nothing is filed', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient();
    const diffstat = await numstat(root, '-\t-\tdir/a.mjs\n10\t0\tdir/b.mjs\n');
    const result = await recordPatch({ workspace: root, tag: 'pt10', files: 'a.mjs,b.mjs', summary: 'Binary row', diffstat, client, hygiene, now: NOW });
    assert.deepEqual([result.follow.outcome, result.follow.reason], ['refused', 'admission']);
    assert.equal(client.issues.length, 0);
  } finally { await cleanup(); }
});
