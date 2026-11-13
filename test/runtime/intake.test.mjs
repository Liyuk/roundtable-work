import test from 'node:test';
import assert from 'node:assert/strict';
import { selectIssues, createIntakeProvider } from '../../runtime/lib/intake.mjs';
import { createGitHubReader } from '../../scripts/github-read.mjs';
import { readQueue } from '../../runtime/lib/queue.mjs';
import { runQueue } from './observation-fixture.mjs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Locks live in the private anchor (RTW_STATE_DIR), never in the work root or the user's real state dir.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-intake-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const admissibleBody = '## Goal\nFixture task.\n\n## Acceptance criteria\nRun: `node --test test/runtime/intake.test.mjs`; Expected: exit 0.\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 20\nFiles: 2';
const issue = (number, labels = ['type:feature'], extra = {}) => ({ number, title: `Issue ${number}`, state: 'OPEN', author: { login: 'owner' }, labels: labels.map(name => ({ name })), createdAt: '2025-01-01T00:00:00Z', ...extra, body: `${admissibleBody}\n${extra.body ?? ''}` });
const select = (issues, states = {}) => selectIssues({ issues, owner: 'owner', dependencyStates: states });
test('eligibility and triage rules', () => {
  for (const label of ['rt:owner', 'rt:deferred', 'rt:running', 'rt:ask', 'rt:blocked', 'rt:hold', 'rt:ready-to-merge', 'rt:proposed', 'type:epic']) {
    assert.deepEqual(select([issue(1, ['type:feature', label])]).issues, [], label);
  }
  for (const extra of [{ title: '[Owner] thing' }, { state: 'CLOSED' }, { author: { login: 'other' } }, { title: '[Epic] thing' }]) assert.deepEqual(select([issue(1, ['type:feature'], extra)]).issues, []);
  assert.equal(select([issue(1, ['type:feature', 'rt:proposed', 'rt:approved'])]).issues.length, 1);
  assert.deepEqual(select([issue(2, []), issue(3, [], { author: { login: 'other' } })]).triage.map(i => i.number), [2]);
});
test('excludes series-prefixed epic titles without excluding ordinary series issues', () => {
  const title = '[RT] Epic: in-repo daemon, layered decisions, external supervision, optional Jev';
  const entries = [
    issue(25, ['type:feature'], { title }),
    issue(26, ['type:bug'], { title }),
    issue(27, ['type:feature'], { title: '[Pages] epic: redesign' }),
    issue(28, ['type:feature'], { title: '[RT] Epicenter improvements' }),
    issue(29, ['type:bug'], { title: '[RT] Fix epic rendering' }),
  ];
  assert.deepEqual(select(entries).issues.map(i => i.number).sort((a, b) => a - b), [28, 29]);
});
test('excludes unprefixed epic titles from candidates and triage', () => {
  const entries = [issue(1, ['type:feature'], { title: 'Epic: roadmap' }), issue(2, [], { title: 'epic: roadmap' }), issue(3, ['type:bug'], { title: 'Epicenter fix' })];
  const result = select(entries);
  assert.deepEqual(result.issues.map(i => i.number), [3]);
  assert.deepEqual(result.triage, []);
});
test('Markdown-emphasized dependencies block selection until closed', async () => {
  for (const body of ['**Depends on #42**', '- **Blocked by #42**', '**Depends on** #42']) {
    let state = 'OPEN';
    const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue(1, ['type:bug'], { body })], getIssue: async () => ({ state }) });
    assert.deepEqual((await readQueue(provider)).items, [], body);
    state = 'CLOSED';
    assert.deepEqual((await readQueue(provider)).items.map(i => i.id), ['1'], body);
  }
});
test('dependencies fail closed and become eligible when closed', async () => {
  let state = 'OPEN';
  const candidate = issue(1, ['type:bug'], { body: 'Depends on #2\nBlocked by #3' });
  const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [candidate], getIssue: async n => ({ state: n === 2 ? state : 'CLOSED' }) });
  assert.deepEqual((await readQueue(provider)).items, []);
  state = 'CLOSED';
  assert.deepEqual((await readQueue(provider)).items.map(i => i.id), ['1']);
  for (const states of [{}, { 2: 'OPEN', 3: 'CLOSED' }, { 2: 'UNKNOWN', 3: 'CLOSED' }]) assert.equal(select([candidate], states).issues.length, 0);
});
test('repository-qualified dependencies are not resolved in the selected repository', async () => {
  const candidate = issue(1, ['type:bug'], { body: 'Depends on other-owner/other-repo#50' });
  const lookups = [];
  const provider = createIntakeProvider({
    getOwner: async () => 'owner',
    listIssues: async () => [candidate],
    getIssue: async number => { lookups.push(number); return { state: 'CLOSED' }; },
  });

  assert.deepEqual((await readQueue(provider)).items.map(item => item.id), ['1']);
  assert.deepEqual(lookups, []);
});
test('repository-qualified references do not shadow local dependencies on the same line', async () => {
  const candidate = issue(1, ['type:bug'], { body: 'Depends on other-owner/other-repo#50 and #2' });
  const lookups = [];
  let localState = 'OPEN';
  const provider = createIntakeProvider({
    getOwner: async () => 'owner',
    listIssues: async () => [candidate],
    getIssue: async number => { lookups.push(number); return { state: localState }; },
  });

  assert.deepEqual((await readQueue(provider)).items, []);
  assert.deepEqual(lookups, [2]);
  localState = 'CLOSED';
  assert.deepEqual((await readQueue(provider)).items.map(item => item.id), ['1']);
  assert.deepEqual(lookups, [2, 2]);
});
test('listed dependencies block selection until closed', async () => {
  for (const marker of ['- ', '* ', '+ ', '1. ', '2) ']) {
    for (const phrase of ['Depends on', 'Blocked by']) {
      const candidate = issue(1, ['type:bug'], { body: `  ${marker}${phrase} #42` });
      let state = 'OPEN';
      const provider = createIntakeProvider({
        getOwner: async () => 'owner',
        listIssues: async () => [candidate],
        getIssue: async () => { if (state === 'MISSING') throw new Error('not found'); return { state }; },
      });
      for (state of ['OPEN', 'MISSING']) assert.deepEqual((await readQueue(provider)).items, [], `${marker}${phrase}: ${state}`);
      state = 'CLOSED';
      assert.deepEqual((await readQueue(provider)).items.map(item => item.id), ['1'], `${marker}${phrase}: CLOSED`);
    }
  }
});
test('task-list dependencies block selection until closed', async () => {
  for (const marker of ['- [ ] ', '- [x] ', '* [X] ', '+ [ ] ']) {
    for (const phrase of ['Depends on', 'Blocked by']) {
      const candidate = issue(1, ['type:bug'], { body: `${marker}${phrase} #42` });
      let state = 'OPEN';
      const provider = createIntakeProvider({
        getOwner: async () => 'owner',
        listIssues: async () => [candidate],
        getIssue: async () => { if (state === 'MISSING') throw new Error('not found'); return { state }; },
      });
      for (state of ['OPEN', 'MISSING']) assert.deepEqual((await readQueue(provider)).items, [], `${marker}${phrase}: ${state}`);
      state = 'CLOSED';
      assert.deepEqual((await readQueue(provider)).items.map(item => item.id), ['1'], `${marker}${phrase}: CLOSED`);
    }
  }
});
test('GitHub adapter uses the selected repository for each read', async () => {
  const calls = [];
  const fixtures = [{ owner: { login: 'selected-owner' } }, [], { state: 'CLOSED' }];
  const reader = createGitHubReader({ repo: 'selected-owner/selected-repo', run: async args => { calls.push(args); return fixtures[calls.length - 1]; } });
  assert.equal(await reader.getOwner(), 'selected-owner');
  await reader.listIssues();
  await reader.getIssue(42);
  assert.deepEqual(calls, [
    ['repo', 'view', 'selected-owner/selected-repo', '--json', 'owner'],
    ['issue', 'list', '--repo', 'selected-owner/selected-repo', '--state', 'open', '--limit', '1000', '--json', 'number,title,state,author,labels,createdAt,updatedAt,body,url'],
    ['issue', 'view', '42', '--repo', 'selected-owner/selected-repo', '--json', 'state'],
  ]);
});
test('orders by bug, priority, self, age and extracts series', () => {
  const result = select([issue(1), issue(2, ['type:feature', 'priority:p2']), issue(3, ['type:feature', 'priority:p1']), issue(4, ['type:feature', 'priority:p0']), issue(5, ['type:bug']), issue(6, ['type:bug', 'priority:p2']), issue(7, ['type:bug', 'priority:p2', 'rt:self']), issue(8, ['type:bug', 'priority:p2', 'rt:self'], { createdAt: '2020-01-01T00:00:00Z', title: '[Pages] build' })]);
  assert.deepEqual(result.issues.map(i => i.id), ['8','7','6','5','4','3','2','1']);
  assert.equal(result.issues[0].series, 'Pages');
  assert.equal(select([issue(9, ['type:bug'], { title: '[I18N] text' }), issue(10, ['type:bug'], { title: '[RT] text' })]).issues[1].series, 'RT');
});
test('GitHub adapter only invokes read-only allowlisted commands', async () => {
  const calls = [];
  const reader = createGitHubReader({ run: async args => { calls.push(args); return args[0] === 'repo' ? { owner: { login: 'owner' } } : args[1] === 'list' ? [] : { state: 'CLOSED' }; } });
  await reader.getOwner(); await reader.listIssues(); await reader.getIssue(42);
  assert.deepEqual(calls.map(a => a.slice(0, 2)), [['repo','view'], ['issue','list'], ['issue','view']]);
});

test('provider ordering survives queue normalization and failed dependency reads fail closed', async () => {
  const entries = [issue(1, ['type:feature']), issue(2, ['type:bug'], { body: 'Blocked by #99' }), issue(3, ['type:bug'])];
  const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => entries, getIssue: async () => { throw new Error('not found'); } });
  assert.deepEqual((await readQueue(provider)).items.map(i => i.id), ['3', '1']);
});

test('reader rejects incomplete tracker lists and invalid dependency IDs', async () => {
  const reader = createGitHubReader({ run: async () => Array(1000).fill({}) });
  await assert.rejects(reader.listIssues(), /truncated/);
  await assert.rejects(reader.getIssue(0), /Invalid/);
});

test('runQueue selects tracker fixtures after dependencies close', async () => {
  const base = new URL('../../.roundtable/scratch/50-dev/', import.meta.url);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(new URL('queue-', base).pathname);
  try {
    let dependency = 'OPEN';
    const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue(10, ['type:bug'], { body: 'Depends on #11' })], getIssue: async () => ({ state: dependency }) });
    const handler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' });
    assert.deepEqual((await runQueue({ workRoot: root, queue: provider, handler })).outcomes, []);
    dependency = 'CLOSED';
    assert.deepEqual((await runQueue({ workRoot: root, queue: provider, handler })).outcomes.map(({ id, status }) => [id, status]), [['10', 'done']]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tracker intake includes rt:ask and rt:blocked issues and carries owner identity for resumption', async () => {
  const paused = issue(32, ['rt:ask'], { title: '[A] paused' });
  const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [paused] }, { includeRunning: true });
  const items = await provider();
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].author, paused.author);
  assert.deepEqual(items[0].labels.map(label => label.name), ['rt:ask']);
});

test('corrupt state for an unrelated issue does not abort intake', async () => {
  const base = new URL('../../.roundtable/scratch/97-implementation/', import.meta.url);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(new URL('corrupt-', base).pathname);
  try {
    const { writeFile } = await import('node:fs/promises');
    const { createStateStore } = await import('../../runtime/lib/state.mjs');
    const store = await createStateStore({ workRoot: root });
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(join(root, 'state', '99.json'), '{invalid');
    const entries = [issue(1, ['type:bug']), issue(99, ['type:feature'], { author: { login: 'other' } }), issue(2)];
    const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => entries }, { includeRunning: true });
    assert.deepEqual((await provider({ store, client: {} })).map(item => item.number), [1, 2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('held parents release only with valid durable child IDs after every child closes', async () => {
  const base = new URL('../../.roundtable/scratch/97-implementation/', import.meta.url);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(new URL('held-', base).pathname);
  try {
    const { createStateStore } = await import('../../runtime/lib/state.mjs');
    const store = await createStateStore({ workRoot: root });
    const held = issue(90, ['type:feature', 'rt:hold']);
    const unrelated = issue(91, ['type:feature', 'rt:hold']);
    await store.update('90', s => { s.status = 'waiting_external'; s.decomposition = { status: 'waiting', childIds: [101, 102] }; });
    await store.update('91', s => { s.status = 'waiting_external'; });
    let statuses = { 101: 'CLOSED', 102: 'OPEN' };
    const events = [];
    const client = { removeLabel: async (id, label) => events.push(['removeLabel', id, label]) };
    const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [held, unrelated], getIssue: async id => ({ state: statuses[id] }) }, { includeRunning: true });
    assert.deepEqual(await provider({ store, client }), []);
    assert.deepEqual(events, []);
    statuses[102] = 'CLOSED';
    const items = await provider({ store, client });
    assert.deepEqual(items.map(item => item.number), [90]);
    assert.deepEqual(events, [['removeLabel', 90, 'rt:hold']]);
    assert.equal((await store.load('90')).status, 'queued');
    assert.equal((await store.load('90')).decomposition.status, 'released');
    assert.equal((await store.load('91')).status, 'waiting_external');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovers a held parent after child labeling fails without duplicating its child', async () => {
  const base = new URL('../../.roundtable/scratch/97-implementation/', import.meta.url);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(new URL('interrupted-', base).pathname);
  try {
    const { writeFile } = await import('node:fs/promises');
    const { createStateStore } = await import('../../runtime/lib/state.mjs');
    const { applyDecision } = await import('../../runtime/lib/decisions.mjs');
    await writeFile(`${root}/child.json`, JSON.stringify({ title: 'Child', body: 'Work' }));
    const store = await createStateStore({ workRoot: root });
    const labels = new Set(['type:feature']);
    let childState = 'OPEN', creations = 0, failLabel = true;
    const childLabels = new Set();
    const client = {
      createComment: async () => {},
      createIssue: async () => { creations++; return { number: 101 }; },
      addLabel: async (id, label) => {
        if (id === 101 && failLabel) { failLabel = false; throw new Error('label failed'); }
        if (id === 90) labels.add(label);
        if (id === 101) childLabels.add(label);
      },
      removeLabel: async (id, label) => { if (id === 90) labels.delete(label); },
    };
    await assert.rejects(applyDecision({ decision: { decision: 'decompose', drafts: ['child.json'] }, issue: { number: 90 }, store, client, repoRoot: root }), /label failed/);
    assert.deepEqual((await store.load('90')).decomposition.childIds, [101]);
    const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue(90, [...labels])], getIssue: async () => ({ state: childState }) }, { includeRunning: true });
    assert.deepEqual(await provider({ store, client }), []);
    assert.equal(labels.has('rt:hold'), true);
    assert.equal(childLabels.has('rt:self'), true);
    childState = 'CLOSED';
    assert.deepEqual((await provider({ store, client })).map(item => item.number), [90]);
    assert.equal(creations, 1);
    assert.deepEqual((await store.load('90')).decomposition.childIds, [101]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recovers remaining drafts after an early label interruption without duplicating children', async () => {
  const base = new URL('../../.roundtable/scratch/97-implementation/', import.meta.url);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(new URL('remaining-', base).pathname);
  try {
    const { writeFile } = await import('node:fs/promises');
    const { createStateStore } = await import('../../runtime/lib/state.mjs');
    const { applyDecision } = await import('../../runtime/lib/decisions.mjs');
    for (const n of [1, 2]) await writeFile(`${root}/${n}.json`, JSON.stringify({ title: `Child ${n}`, body: 'Work' }));
    const store = await createStateStore({ workRoot: root });
    const labels = new Set(['type:feature']);
    const childLabels = new Set();
    const created = [];
    let fail = true, closed = false;
    const client = {
      createComment: async () => {},
      createIssue: async title => { created.push(title); return { number: 100 + created.length }; },
      addLabel: async (id, label) => {
        if (id === 101 && fail) { fail = false; throw new Error('label failed'); }
        if (id === 90) labels.add(label); else childLabels.add(id);
      },
      removeLabel: async (id, label) => { if (id === 90) labels.delete(label); },
    };
    await assert.rejects(applyDecision({ decision: { decision: 'decompose', drafts: ['1.json', '2.json'] }, issue: { number: 90 }, store, client, repoRoot: root }), /label failed/);
    const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue(90, [...labels])], getIssue: async () => ({ state: closed ? 'CLOSED' : 'OPEN' }) }, { includeRunning: true });
    assert.deepEqual(await provider({ store, client }), []);
    assert.deepEqual(created, ['Child 1', 'Child 2']);
    assert.deepEqual([...childLabels], [101, 102]);
    assert.equal(labels.has('rt:hold'), true);
    closed = true;
    assert.deepEqual((await provider({ store, client })).map(item => item.number), [90]);
    assert.deepEqual(created, ['Child 1', 'Child 2']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('does not retry an ambiguous later creation or release its parent', async () => {
  const base = new URL('../../.roundtable/scratch/97-implementation/', import.meta.url);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(new URL('ambiguous-', base).pathname);
  try {
    const { writeFile } = await import('node:fs/promises');
    const { createStateStore } = await import('../../runtime/lib/state.mjs');
    const { applyDecision } = await import('../../runtime/lib/decisions.mjs');
    for (const n of [1, 2]) await writeFile(`${root}/${n}.json`, JSON.stringify({ title: `Child ${n}`, body: 'Work' }));
    const store = await createStateStore({ workRoot: root });
    const labels = new Set(['type:feature']);
    let calls = 0;
    const client = {
      createComment: async () => {},
      createIssue: async () => { if (++calls === 2) throw new Error('response lost'); return { number: 101 }; },
      addLabel: async (id, label) => { if (id === 90) labels.add(label); },
      removeLabel: async (id, label) => { if (id === 90) labels.delete(label); },
    };
    await assert.rejects(applyDecision({ decision: { decision: 'decompose', drafts: ['1.json', '2.json'] }, issue: { number: 90 }, store, client, repoRoot: root }), /response lost/);
    const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue(90, [...labels])], getIssue: async () => ({ state: 'CLOSED' }) }, { includeRunning: true });
    assert.deepEqual(await provider({ store, client }), []);
    assert.deepEqual(await provider({ store, client }), []);
    assert.equal(calls, 2);
    assert.equal(labels.has('rt:hold'), true);
    assert.equal((await store.load('90')).decomposition.inFlight, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rt:self children without a type label are intake-eligible and sort after type:bug', () => {
  assert.deepEqual(select([issue(1, ['rt:self']), issue(2, ['type:bug']), issue(3, ['type:feature'])]).issues.map(i => i.number), [2, 1, 3]);
  for (const labels of [['rt:self', 'rt:hold'], ['rt:self', 'rt:owner'], ['rt:self', 'rt:proposed'], ['rt:self', 'type:epic']]) assert.deepEqual(select([issue(4, labels)]).issues, [], labels.join());
  assert.deepEqual(select([issue(5, ['rt:self'], { body: 'Depends on #9' })]).issues, []);
});

test('child intake schedules rt:self children and releases the parent only after all close', async () => {
  const base = new URL('../../.roundtable/scratch/97-implementation/', import.meta.url);
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(new URL('cycle-', base).pathname);
  try {
    const { writeFile } = await import('node:fs/promises');
    const { createStateStore } = await import('../../runtime/lib/state.mjs');
    const { applyDecision } = await import('../../runtime/lib/decisions.mjs');
    await writeFile(`${root}/child.json`, JSON.stringify({ title: 'Child', body: 'Work' }));
    const store = await createStateStore({ workRoot: root });
    const tracker = new Map([[90, issue(90, ['type:feature'])]]);
    const client = {
      createComment: async () => {},
      createIssue: async (title, body) => {
        const number = 100 + tracker.size;
        tracker.set(number, issue(number, ['rt:self'], { title, body }));
        return { number };
      },
      addLabel: async (number, label) => { tracker.get(number).labels.push({ name: label }); },
      removeLabel: async (number, label) => { const entry = tracker.get(number); entry.labels = entry.labels.filter(({ name }) => name !== label); },
    };
    await applyDecision({ decision: { decision: 'decompose', drafts: ['child.json'] }, issue: { number: 90 }, store, client, repoRoot: root });
    assert.deepEqual((await store.load('90')).decomposition.childIds, [101]);
    const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [...tracker.values()], getIssue: async number => ({ state: tracker.get(number)?.state ?? 'OPEN' }) }, { includeRunning: true });
    assert.deepEqual((await provider({ store, client })).map(item => item.number), [101]);
    tracker.get(101).state = 'CLOSED';
    assert.deepEqual((await provider({ store, client })).map(item => item.number), [90]);
    assert.equal((await store.load('90')).decomposition.status, 'released');
  } finally { await rm(root, { recursive: true, force: true }); }
});
