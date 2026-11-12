import test from 'node:test';
import assert from 'node:assert/strict';
import { selectIssues, createIntakeProvider } from '../../runtime/lib/intake.mjs';
import { createGitHubReader } from '../../scripts/github-read.mjs';
import { readQueue } from '../../runtime/lib/queue.mjs';
import { runQueue } from '../../runtime/rtd.mjs';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';

const issue = (number, labels = ['type:feature'], extra = {}) => ({ number, title: `Issue ${number}`, state: 'OPEN', author: { login: 'owner' }, labels: labels.map(name => ({ name })), createdAt: '2025-01-01T00:00:00Z', body: '', ...extra });
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
    ['issue', 'list', '--repo', 'selected-owner/selected-repo', '--state', 'open', '--limit', '1000', '--json', 'number,title,state,author,labels,createdAt,body,url'],
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
