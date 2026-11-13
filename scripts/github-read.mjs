import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runGh = async (args, { signal } = {}) => JSON.parse((await exec('gh', args, { signal, maxBuffer: 16 * 1024 * 1024 })).stdout);

/** GitHub's closing keywords followed by an issue number, optionally repository-qualified. */
const CLOSING_REFERENCE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b\s*:?\s+(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#(\d+)\b/gi;
const linkedIssueNumbers = (body, fullName) => {
  const numbers = new Set();
  for (const match of body.matchAll(CLOSING_REFERENCE)) {
    if (match[1] && match[1].toLowerCase() !== fullName) continue;
    const number = Number(match[2]);
    if (Number.isSafeInteger(number) && number > 0) numbers.add(number);
  }
  return numbers;
};

/** Only these fixed read-only gh commands can be invoked; no shell is involved. */
export function createGitHubReader({ repo, run = runGh } = {}) {
  const repository = repo ? ['--repo', repo] : [];
  return {
    async getOwner(options) {
      const result = await run(['repo', 'view', ...(repo ? [repo] : []), '--json', 'owner'], options);
      if (!result?.owner?.login) throw new TypeError('Repository owner is missing');
      return result.owner.login;
    },
    async getRepository(options) {
      const result = await run(['repo', 'view', ...(repo ? [repo] : []), '--json', 'owner,name'], options);
      if (!result?.owner?.login || !result?.name) throw new TypeError('Repository identity is missing');
      return { owner: result.owner.login, name: result.name };
    },
    async listRecentMerges(options) {
      const result = await run(['pr', 'list', ...repository, '--state', 'merged', '--limit', '10', '--json', 'number,title,mergedAt,headRefName,baseRefName'], options);
      if (!Array.isArray(result)) throw new TypeError('Invalid merged pull requests');
      return result.map(({ number, title, mergedAt, headRefName, baseRefName }) => ({ number, title, mergedAt, headRefName, baseRefName }));
    },
    async listLinkedPullRequests({ owner, name } = {}, options) {
      if (typeof owner !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(owner) || typeof name !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(name)) throw new TypeError('Invalid repository identity');
      const fullName = `${owner}/${name}`;
      // `gh pr list` exposes no closing-reference field, so bodies are filtered locally; only numbers and titles are returned.
      const result = await run(['pr', 'list', '--repo', fullName, '--state', 'all', '--limit', '1000', '--json', 'number,title,body'], options);
      if (!Array.isArray(result) || result.length >= 1000) throw new TypeError('Invalid linked pull requests');
      const linked = {};
      for (const pr of result) {
        if (!Number.isSafeInteger(pr?.number) || typeof pr?.title !== 'string' || typeof pr?.body !== 'string') throw new TypeError('Invalid linked pull request');
        for (const issue of linkedIssueNumbers(pr.body, fullName.toLowerCase())) (linked[issue] ??= []).push({ number: pr.number, title: pr.title });
      }
      return linked;
    },
    async listIssues(options) {
      const result = await run(['issue', 'list', ...repository, '--state', 'open', '--limit', '1000', '--json', 'number,title,state,author,labels,createdAt,updatedAt,body,url'], options);
      if (!Array.isArray(result) || result.length >= 1000) throw new TypeError('Issue list is invalid or may be truncated');
      return result;
    },
    async getIssue(number, options) {
      if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('Invalid issue number');
      return run(['issue', 'view', String(number), ...repository, '--json', 'state'], options);
    },
    async listComments(number, options) {
      if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('Invalid issue number');
      const result = await run(['issue', 'view', String(number), ...repository, '--json', 'comments'], options);
      if (!Array.isArray(result?.comments)) throw new TypeError('Issue comments are invalid');
      return result.comments;
    },
  };
}

/** Tracker writes used by daemon claims and decomposition, plus claim comment lookup. */
export function createGitHubWriter({ repo, run = async (args) => (await exec('gh', args, { maxBuffer: 16 * 1024 * 1024 })).stdout } = {}) {
  const repository = repo ? ['--repo', repo] : [];
  const id = (number) => {
    const value = Number(number);
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid issue number');
    return String(value);
  };
  return {
    createIssue: async (title, body) => {
      const output = await run(['issue', 'create', ...repository, '--title', title, '--body', body]);
      const match = String(output).match(/(?:\/issues\/|#)(\d+)\s*$/);
      if (!match) throw new TypeError('GitHub did not return a child issue number');
      return { number: Number(match[1]) };
    },
    addLabel: (number, label) => run(['issue', 'edit', id(number), ...repository, '--add-label', label]),
    removeLabel: (number, label) => run(['issue', 'edit', id(number), ...repository, '--remove-label', label]),
    createComment: (number, body) => run(['issue', 'comment', id(number), ...repository, '--body', body]),
    listComments: async (number) => JSON.parse(await run(['issue', 'view', id(number), ...repository, '--json', 'comments'])).comments,
    listOpenPullRequests: async ({ headPrefix } = {}) => {
      if (typeof headPrefix !== 'string' || !/^rt\/\d+-$/.test(headPrefix)) throw new TypeError('Invalid head branch prefix');
      const pulls = JSON.parse(await run(['pr', 'list', ...repository, '--state', 'open', '--limit', '1000', '--json', 'number,headRefName,state']));
      if (!Array.isArray(pulls) || pulls.length >= 1000) throw new TypeError('Pull request list is invalid or may be truncated');
      const matching = pulls.filter(pull => typeof pull?.headRefName === 'string' && pull.headRefName.startsWith(headPrefix));
      if (matching.some(pull => !Number.isSafeInteger(pull.number) || typeof pull.state !== 'string')) throw new TypeError('Invalid pull request');
      return matching.map(({ number, headRefName, state }) => ({ number, headRefName, state }));
    },
    closePullRequest: (number, body) => run(['pr', 'close', id(number), ...repository, '--comment', body]),
  };
}
