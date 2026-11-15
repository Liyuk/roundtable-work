import { createGitHubReader } from '../../../scripts/github-read.mjs';

const toReport = (issue) => ({
  url: issue.url,
  author: issue.author.login,
  text: issue.title + '\n' + issue.body,
  time: issue.updatedAt,
  source_event_id: `github-issue:${issue.number}:${issue.updatedAt}`,
});

// Read-only GitHub issues adapter: reads only through the shared GitHub reader; no write method is exposed.
export function createGithubIssuesAdapter({ repo, run } = {}) {
  const reader = createGitHubReader({ repo, run });
  const parse = (payload) => (Array.isArray(payload) ? payload : [payload]).map(toReport);
  const poll = async (since) => {
    // Closed issues are not intake sources for now; listIssues requests open issues only.
    const threshold = since === undefined ? -Infinity : new Date(since).getTime();
    const issues = await reader.listIssues();
    return parse(issues.filter((issue) => Date.parse(issue.updatedAt) >= threshold));
  };
  return { parse, poll };
}

export default createGithubIssuesAdapter();
