import test from 'node:test';
import assert from 'node:assert/strict';
import { selectIssues } from '../../runtime/lib/intake.mjs';
import { intakeRequestIssue, createBacklog } from '../../runtime/lib/intake-backlog.mjs';

const request = (title, dependsOn) => ({
  title,
  goal: `Goal of ${title}.`,
  acceptance: [{ run: 'node --test test/runtime/intake-backlog.test.mjs', expected: 'exit 0' }],
  outOfScope: 'Chat UI.',
  dependsOn,
  files: 2,
  lines: 40,
});

// Fake tracker: records created issues, labels, and states; no network.
function fakeTracker() {
  const issues = [];
  const client = {
    createIssue: async (title, body) => {
      const number = issues.length + 1;
      issues.push({ number, title, body, state: 'OPEN', author: { login: 'owner' }, labels: [], createdAt: `2025-01-01T00:00:${String(number).padStart(2, '0')}Z` });
      return { number };
    },
    addLabel: async (number, label) => { issues[number - 1].labels.push({ name: label }); },
  };
  return { issues, client };
}

// Runs the daemon-style loop: select from a snapshot, claim, and close each selected issue.
function drain(issues) {
  const finished = [];
  for (;;) {
    const states = Object.fromEntries(issues.map(issue => [issue.number, issue.state]));
    const { issues: selected } = selectIssues({ issues, owner: 'owner', dependencyStates: states });
    if (!selected.length) return finished;
    for (const { number } of selected) {
      issues[number - 1].state = 'CLOSED';
      finished.push(number);
    }
  }
}

test('a request becomes an issue that intake admits without manual labeling', () => {
  const draft = intakeRequestIssue(request('Add X'));
  assert.deepEqual(draft.labels, ['type:feature', 'rt:go']);
  for (const heading of ['## Goal', '## Acceptance criteria', '## Out of scope', '## Dependencies', '## Size estimate']) {
    assert.match(draft.body, new RegExp(`^${heading}$`, 'm'));
  }
  assert.match(draft.body, /^- Run: `node --test test\/runtime\/intake-backlog\.test\.mjs`; Expected: exit 0$/m);
  assert.match(draft.body, /^Changed lines: 40$/m);
  assert.match(draft.body, /^Files: 2$/m);

  const { issues } = selectIssues({
    issues: [{ number: 1, title: draft.title, body: draft.body, state: 'OPEN', author: { login: 'owner' }, labels: draft.labels.map(name => ({ name })), createdAt: '2025-01-01T00:00:00Z' }],
    owner: 'owner',
  });
  assert.deepEqual(issues.map(issue => issue.number), [1]);
});

test('a backlog of N independent tasks runs to completion with no owner step', async () => {
  const { issues, client } = fakeTracker();
  const numbers = await createBacklog('Ship feature', [request('Task A'), request('Task B'), request('Task C')], client);

  assert.deepEqual(numbers, [1, 2, 3]);
  for (const issue of issues) assert.match(issue.body, /^None\.$/m);
  assert.deepEqual(drain(issues), [1, 2, 3]);
  assert.ok(issues.every(issue => issue.state === 'CLOSED'));
});

test('a task paused by an ask category in the middle blocks only itself', async () => {
  const { issues, client } = fakeTracker();
  await createBacklog('Ship feature', [request('Task A'), { ...request('Task B'), ask: 'scope' }, request('Task C')], client);

  assert.deepEqual(issues.map(issue => issue.labels.some(label => label.name === 'rt:ask')), [false, true, false]);
  assert.deepEqual(drain(issues), [1, 3]);
  assert.equal(issues[1].state, 'OPEN');
});
