/**
 * Gate 1 precondition, read through the injected observation clients: the reviewer reads the worktree, so it may
 * only run on a clean tree (`worktree.inspect` reports `dirty: false` for no staged, unstaged or untracked change)
 * whose local HEAD is the pushed PR head. Returns `null` when clear, otherwise why the review must wait.
 */
export function createReviewPrecondition({ clients, issue, github }) {
  return async ({ pr }) => {
    if ((await clients.worktree.inspect(issue)).dirty !== false) return 'worktree is not known to be clean';
    const local = await clients.git.head(issue);
    const pushed = (await github.getPullRequest(pr)).head;
    return local === pushed ? null : `local HEAD ${local} is not the pushed PR head ${pushed}`;
  };
}
