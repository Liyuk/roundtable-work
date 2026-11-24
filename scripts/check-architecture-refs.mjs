// Reference check for the module-status catalog in docs/architecture.md. Every code path of a module must exist in the
// tree, and every issue number must name an issue (or pull request) of this repository. CI runs it on pull requests and
// on main.
//
//   GITHUB_REPOSITORY=owner/repo [GITHUB_TOKEN=...] node scripts/check-architecture-refs.mjs
//
// Issue existence is read from the GitHub REST API. CI passes its own read-only GITHUB_TOKEN; no secret is added.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './entry.mjs';
import { parseModuleStatus } from './build-site.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Problems found in the catalog's references; empty when all resolve. Throws when the catalog cannot be parsed. */
export async function checkArchitectureRefs({ doc, root, issueExists }) {
  const problems = [];
  const known = new Map();
  for (const m of parseModuleStatus(doc)) {
    for (const path of m.code) if (!existsSync(join(root, path))) problems.push(`${m.id}: missing file ${path}`);
    for (const n of m.issues) {
      if (!known.has(n)) known.set(n, await issueExists(n));
      if (!known.get(n)) problems.push(`${m.id}: issue #${n} does not exist`);
    }
  }
  return problems;
}

/** True when `#n` exists in `repo`. A 404 is false; any other failure throws, so an outage is never read as a pass. */
export async function githubIssueExists(repo, n, token = process.env.GITHUB_TOKEN) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${n}`, {
    headers: { Accept: 'application/vnd.github+json', ...(token && { Authorization: `Bearer ${token}` }) },
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`issue #${n}: GitHub answered ${res.status}`);
  return true;
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('set GITHUB_REPOSITORY=owner/repo');
  const doc = readFileSync(join(root, 'docs', 'architecture.md'), 'utf8');
  const problems = await checkArchitectureRefs({ doc, root, issueExists: (n) => githubIssueExists(repo, n) });
  if (problems.length) {
    console.error(`Architecture reference check failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exitCode = 1;
  } else console.log('Architecture reference check passed: every code path exists and every issue exists.');
}

if (isEntry(import.meta.url)) main();
