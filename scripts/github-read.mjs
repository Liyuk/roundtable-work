import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runGh = async (args, { signal } = {}) => JSON.parse((await exec('gh', args, { signal, maxBuffer: 16 * 1024 * 1024 })).stdout);

/** Only these fixed read-only gh commands can be invoked; no shell is involved. */
export function createGitHubReader({ repo, run = runGh } = {}) {
  const repository = repo ? ['--repo', repo] : [];
  return {
    async getOwner(options) {
      const result = await run(['repo', 'view', ...(repo ? [repo] : []), '--json', 'owner'], options);
      if (!result?.owner?.login) throw new TypeError('Repository owner is missing');
      return result.owner.login;
    },
    async listIssues(options) {
      const result = await run(['issue', 'list', ...repository, '--state', 'open', '--limit', '1000', '--json', 'number,title,state,author,labels,createdAt,body,url'], options);
      if (!Array.isArray(result) || result.length >= 1000) throw new TypeError('Issue list is invalid or may be truncated');
      return result;
    },
    async getIssue(number, options) {
      if (!Number.isSafeInteger(number) || number < 1) throw new TypeError('Invalid issue number');
      return run(['issue', 'view', String(number), ...repository, '--json', 'state'], options);
    },
  };
}

/** Restricted issue mutations and comment lookup for daemon claims. */
export function createGitHubWriter({ repo, run = async (args) => (await exec('gh', args, { maxBuffer: 16 * 1024 * 1024 })).stdout } = {}) {
  const repository = repo ? ['--repo', repo] : [];
  const id = (number) => {
    const value = Number(number);
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Invalid issue number');
    return String(value);
  };
  return {
    addLabel: (number, label) => run(['issue', 'edit', id(number), ...repository, '--add-label', label]),
    removeLabel: (number, label) => run(['issue', 'edit', id(number), ...repository, '--remove-label', label]),
    createComment: (number, body) => run(['issue', 'comment', id(number), ...repository, '--body', body]),
    async createIssue({ title, body }) {
      if (typeof title !== 'string' || !title.trim() || typeof body !== 'string') throw new TypeError('Issue title and body are required');
      const output = await run(['issue', 'create', ...repository, '--title', title, '--body', body]);
      const match = String(output).match(/\/issues\/(\d+)(?:\s|$)/);
      if (!match) throw new TypeError('GitHub did not return a created issue URL');
      return { number: Number(match[1]) };
    },
    async getIssue(number) {
      const output = await run(['issue', 'view', id(number), ...repository, '--json', 'state']);
      return typeof output === 'string' ? JSON.parse(output) : output;
    },
    listComments: async (number) => JSON.parse(await run(['issue', 'view', id(number), ...repository, '--json', 'comments'])).comments,
  };
}
