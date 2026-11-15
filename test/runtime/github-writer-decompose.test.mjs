import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubWriter } from '../../scripts/github-read.mjs';

test('searchIssues lists all states for the repository and returns number, title and body', async () => {
  const calls = [];
  const writer = createGitHubWriter({ repo: 'owner/repo', run: async args => { calls.push(args); return JSON.stringify([{ number: 7, title: 'Child', body: 'b', extra: 1 }]); } });
  assert.deepEqual(await writer.searchIssues('Child'), [{ number: 7, title: 'Child', body: 'b' }]);
  assert.deepEqual(calls, [['issue', 'list', '--repo', 'owner/repo', '--search', 'Child', '--state', 'all', '--limit', '100', '--json', 'number,title,body']]);
  await assert.rejects(writer.searchIssues(''), TypeError);
  await assert.rejects(createGitHubWriter({ repo: 'owner/repo', run: async () => '{"not":"array"}' }).searchIssues('x'), TypeError);
  await assert.rejects(createGitHubWriter({ run: async () => JSON.stringify([{ number: 1.5, title: 't', body: '' }]) }).searchIssues('x'), TypeError);
});

test('updateIssueBody edits the body of a validated issue number', async () => {
  const calls = [];
  const writer = createGitHubWriter({ repo: 'owner/repo', run: async args => { calls.push(args); return ''; } });
  await writer.updateIssueBody(42, 'new body');
  assert.deepEqual(calls, [['issue', 'edit', '42', '--repo', 'owner/repo', '--body', 'new body']]);
  await assert.rejects(writer.updateIssueBody(0, 'x'), TypeError);
  await assert.rejects(writer.updateIssueBody(1, ''), TypeError);
  assert.equal(calls.length, 1);
});
