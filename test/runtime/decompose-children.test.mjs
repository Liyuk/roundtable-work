import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyDecision, resumeDecomposition } from '../../runtime/lib/decisions.mjs';
import { dependencies } from '../../runtime/lib/intake.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';

const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-decompose-children-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

// Fake tracker: `fail(title)` decides whether a create call throws; `keep` records the issue before throwing,
// which models a response lost after the tracker already created the issue.
function tracker() {
  const issues = [], created = [], updates = [];
  const client = {
    issues, created, updates,
    fail: () => false, keep: false,
    createIssue: async (title, body) => {
      created.push(title);
      const issue = { number: 100 + issues.length + 1, title, body };
      if (client.fail(title)) { if (client.keep) issues.push(issue); throw new Error('response lost'); }
      issues.push(issue);
      return { number: issue.number };
    },
    updateIssueBody: async (number, body) => { updates.push(number); issues.find(issue => issue.number === number).body = body; },
    searchIssues: async text => issues.filter(issue => issue.title.includes(text)),
    addLabel: async () => {}, removeLabel: async () => {}, createComment: async () => ({ id: 1 }), listComments: async () => [],
  };
  return client;
}

async function writeDrafts(root, list) {
  const repoRoot = join(root, 'repo');
  await mkdir(repoRoot, { recursive: true });
  const paths = [];
  for (const [index, draft] of list.entries()) {
    await writeFile(join(repoRoot, `${index + 1}.json`), JSON.stringify(draft));
    paths.push(`${index + 1}.json`);
  }
  return { repoRoot, paths };
}

async function withRoot(fn) {
  const base = new URL('../../.roundtable/scratch/332-dev/', import.meta.url);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(new URL('case-', base).pathname);
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const decompose = ({ paths, store, client, repoRoot }) =>
  applyDecision({ decision: { decision: 'decompose', drafts: paths }, issue: { number: 90 }, store, client, repoRoot, retryDelayMs: 0 });
// Series rule from the issue: the full tag minus a trailing letter.
const seriesOf = title => /^\[([^\]]+)\]/.exec(title)[1].replace(/[a-z]$/, '');

test('phase 2 rewrites a forward sub:NN reference to the real child number', () => withRoot(async root => {
  const { repoRoot, paths } = await writeDrafts(root, [
    { title: 'Child one', body: 'Needs the second child first.\nDepends on sub:02' },
    { title: 'Child two', body: 'Second child, mentions sub:02 again.' },
  ]);
  const store = await createStateStore({ workRoot: root });
  const client = tracker();
  const result = await decompose({ paths, store, client, repoRoot });
  assert.deepEqual(result.childIds, [101, 102]);
  assert.deepEqual(client.created, ['[90-1a] Child one', '[90-1b] Child two']);
  const first = client.issues[0].body;
  assert.match(first, /^Depends on: #102$/m);
  assert.equal(/sub:/.test(first), false);
  assert.deepEqual(dependencies(first), [102]);
  assert.match(client.issues[1].body, /#102/);
  assert.deepEqual((await store.load('90')).decomposition.childIds, [101, 102]);
}));

test('a create that fails after the issue exists is reused by search instead of duplicated', () => withRoot(async root => {
  const { repoRoot, paths } = await writeDrafts(root, [{ title: 'Child one', body: 'Work.' }]);
  const store = await createStateStore({ workRoot: root });
  const client = tracker();
  let failed = false;
  client.fail = () => !failed && (failed = true);
  client.keep = true;
  const result = await decompose({ paths, store, client, repoRoot });
  assert.deepEqual(result.childIds, [101]);
  assert.equal(client.created.length, 1, 'the retry found the issue by search and did not create a second one');
  assert.equal(client.issues.length, 1, 'the retry reused the issue the failed create left behind');
  assert.deepEqual((await store.load('90')).decomposition.childIds, [101]);
}));

test('a partially created set resumes from the first missing draft without duplicates', () => withRoot(async root => {
  const { repoRoot, paths } = await writeDrafts(root, [
    { title: 'Child one', body: 'Work one.' },
    { title: 'Child two', body: 'Work two.' },
    { title: 'Child three', body: 'Work three.' },
  ]);
  const store = await createStateStore({ workRoot: root });
  const client = tracker();
  client.fail = title => title.includes('Child two');
  await assert.rejects(decompose({ paths, store, client, repoRoot }), /response lost/);
  const partial = (await store.load('90')).decomposition;
  assert.equal(partial.status, 'creating');
  assert.deepEqual(partial.childIds, [101]);
  assert.equal(partial.drafts.length, 3);
  client.fail = () => false;
  client.created.length = 0;
  const childIds = await resumeDecomposition({ number: 90, store, client, retryDelayMs: 0 });
  assert.deepEqual(client.created, ['[90-2] Child two', '[90-3] Child three']);
  assert.deepEqual(childIds, [101, 102, 103]);
  assert.equal((await store.load('90')).decomposition.status, 'waiting');
}));

test('title tags give unrelated siblings their own number and mutually dependent siblings a shared number', () => withRoot(async root => {
  const { repoRoot, paths } = await writeDrafts(root, [
    { title: 'Independent', body: 'Stands alone.' },
    { title: 'Left', body: 'Depends on sub:03' },
    { title: 'Right', body: 'Depends on sub:02' },
  ]);
  const store = await createStateStore({ workRoot: root });
  const client = tracker();
  await decompose({ paths, store, client, repoRoot });
  const [independent, left, right] = client.created;
  assert.equal(independent, '[90-1] Independent');
  assert.equal(left, '[90-2a] Left');
  assert.equal(right, '[90-2b] Right');
  assert.notEqual(seriesOf(independent), seriesOf(left));
  assert.equal(seriesOf(left), seriesOf(right));
}));
