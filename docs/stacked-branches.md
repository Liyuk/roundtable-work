# Stacked branches

A stacked change is a downstream pull request whose work builds on an upstream pull request that has not merged yet.

## Recording the chain

- The downstream pull request body contains `Stacked on #N`, where `N` is the upstream pull request.
- The issue for the downstream work contains `Depends on #N` or `Blocked by #N`, where `N` is the upstream issue.
- The downstream pull request base stays `main`: it is opened against `main` and is never pointed at the upstream branch.

## Merge order

- Merge upstream before downstream. `nextMergeable` returns a downstream only when every upstream it names is already merged.
- When the upstream merges, the downstream is retargeted to `main` through `github.setBase` (a no-op when it is already `main`), then caught up and merged through the normal merge path.

## Catch-up

- Catch up with `git merge origin/main` only. Never rebase, and never force push.
- Every new head produced by a catch-up is checked again before it is merged. The merge uses the head that passed the checks.

## Conflicts

- A catch-up conflict stops with nothing pushed and the merge aborted.
- Ownership goes to the downstream author: the conflict becomes the next fix round of that pull request and counts against its developer budget.
- When that budget is spent, the issue stops and goes to Chief.

## Blocked and closed upstreams

- A closed (without merge) or blocked upstream means the downstream pull request is never merged.
- A downstream whose upstream is still open waits; it is not retargeted or merged early.

## Missing body

- A pull request whose body cannot be read is held, never treated as unstacked: the hold waits until the body is readable.
