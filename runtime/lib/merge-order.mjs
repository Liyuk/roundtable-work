/** Dependency-ordered merge helpers. Every effect (git, checks, merge, cleanup) is injected. */

const dependsOn = (body = '') => [...body.matchAll(/(?:Depends on|Blocked by) #(\d+)/g)].map(([, n]) => Number(n));

/** Upstream PR numbers named by `Stacked on #N` in a PR body. */
export const stackedOn = (body = '') => [...body.matchAll(/Stacked on #(\d+)/g)].map(([, n]) => Number(n));

/** First PR (input order) whose upstream PRs (`Depends on`, `Blocked by`, `Stacked on`) are all in `merged`; null when none is eligible. */
export function nextMergeable(prs, merged) {
  return prs.find((pr) => [...dependsOn(pr.body), ...stackedOn(pr.body)].every((n) => merged.has(n))) ?? null;
}

/**
 * Stack state of `pr` from the injected `github.getPullRequest`: `{ stacked: false }` when its body names no upstream;
 * otherwise `ready` only when every upstream it names is merged (`nextMergeable`). A closed or open upstream is not ready.
 * A missing or unreadable body fails closed: `{ stacked: true, ready: false }`, never `{ stacked: false }`.
 */
export async function stackStatus(github, pr) {
  const { body } = await github.getPullRequest(pr);
  if (typeof body !== 'string') return { stacked: true, ready: false };
  const upstreams = stackedOn(body);
  if (!upstreams.length) return { stacked: false };
  const merged = new Set();
  for (const n of upstreams) {
    const up = await github.getPullRequest(n);
    if (up.state === 'merged' || up.merged === true) merged.add(n);
  }
  return { stacked: true, ready: nextMergeable([{ number: pr, body }], merged) !== null };
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

/** After the upstream merged: retarget the downstream PR to `base` through the injected `github.setBase`, then `mergeOne`. */
export async function retargetAndMerge({ github, pr, base, ...rest }) {
  await github.setBase(pr, base);
  return mergeOne({ pr, base, ...rest });
}
