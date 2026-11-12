import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const runGh = async (args, { signal } = {}) => JSON.parse((await exec('gh', args, { signal, maxBuffer: 16 * 1024 * 1024 })).stdout);

/** Only these fixed read-only gh commands can be invoked; no shell is involved. */
export function createGitHubReader({ repo, run = runGh } = {}) {
  const repository = repo ? ['--repo', repo] : [];
  return {
    async getOwner(options) {
      const result = await run(['repo', 'view', ...repository, '--json', 'owner'], options);
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
