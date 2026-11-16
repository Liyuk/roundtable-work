import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubWriter } from '../../scripts/github-read.mjs';

test('pull request body read and write pass the expected gh arguments', async () => {
  const calls = [];
  const writer = createGitHubWriter({ repo: 'owner/repo', run: async args => { calls.push(args); return JSON.stringify({ body: 'Body' }); } });
  assert.equal(await writer.getPullRequestBody(340), 'Body');
  await writer.updatePullRequestBody(340, 'New body');
  assert.deepEqual(calls, [
    ['pr', 'view', '340', '--repo', 'owner/repo', '--json', 'body'],
    ['pr', 'edit', '340', '--repo', 'owner/repo', '--body', 'New body'],
  ]);
});

test('pull request body methods reject invalid results and empty bodies', async () => {
  await assert.rejects(createGitHubWriter({ run: async () => JSON.stringify({ body: null }) }).getPullRequestBody(340), TypeError);
  await assert.rejects(createGitHubWriter({ run: async () => '' }).updatePullRequestBody(340, ''), TypeError);
});
