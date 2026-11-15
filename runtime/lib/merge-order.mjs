/** Dependency-ordered merge helpers. Every effect (git, checks, merge, cleanup) is injected. */

const dependsOn = (body = '') => [...body.matchAll(/(?:Depends on|Blocked by) #(\d+)/g)].map(([, n]) => Number(n));

/** First PR (input order) whose `Depends on #N` / `Blocked by #N` PRs are all in `merged`; null when none is eligible. */
export function nextMergeable(prs, merged) {
  return prs.find((pr) => dependsOn(pr.body).every((n) => merged.has(n))) ?? null;
}

/**
 * Sync `pr`'s head with `base` (merge, never rebase or force), re-check every new head, and merge only the head that
 * passed the checks while the base was already in it. `merge({ pr, head })` returns false when the live head moved.
 */
export async function mergeOne({ issue, pr, base, git, checks, merge, cleanup }) {
  let checked = null;
  for (;;) {
    const sync = await git.mergeBase(base);
    if (sync === 'conflict') {
      await git.mergeAbort();
      return { stop: 'conflict' };
    }
    if (sync === 'clean') await git.push();
    const head = await git.head();
    if (sync === 'up-to-date' && head === checked) break;
    if (!(await checks.run(head))) return { stop: 'checks-failed' };
    checked = head;
  }
  if (!(await merge({ pr, head: checked }))) return { stop: 'head-moved' };
  await cleanup(issue);
  return { merged: true };
}
