# Project Contracts and Invariants

This file is the one conventional place for project contracts and invariants. Assignment cards and review checklists cite it by path and section, for example `docs/project-contracts.md#identity-keys`. A card or checklist that depends on a rule here should name the section instead of restating it.

Each rule says whether the code enforces it or whether it is a convention that the team follows. Do not treat a convention as a guarantee.

## Identity keys

**Work item (issue).** Authoritative key: the GitHub issue number in the configured repository, used as a decimal string.
- Enforced: the state file is `<work root>/state/<id>.json`; the id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` and must not contain `..` (`assertSafeId` in `runtime/lib/paths.mjs`).
- Enforced: intake admits only open issues whose author is the repository owner (`runtime/lib/intake.mjs`).
- Convention: local ticket files are named by issue number (for example `.roundtable/tickets/46.md`).

**Claim and lock.** The per-issue claim is the `rt:running` label plus the `<!-- rt:claim -->` marker. Locks are per issue (`<id>.lock.d`) and carry an owner string such as `worker-<pid>-<id>` or `claim-<pid>-<id>` (`runtime/lib/workers.mjs`, `runtime/lib/claim.mjs`). Locks expire after a time-to-live. A label alone is not proof of an active claim.

**Lease and epoch.** Authoritative for writes: the state's `lockEpoch`. A writer with an older epoch is rejected with `StaleEpochError`, and a newer owner's checkpoint is never replaced by a delayed older one (`runtime/lib/state.mjs`).

**Pull request and head.** A pull request is identified by its number. Merge evidence is bound to the issue, the head SHA and the tree SHA. The merge entry point refuses to merge unless the persisted gate record has the same issue, head and tree and the live pull request still has that head (`runtime/lib/merge.mjs`).

**Session and role.** A role (`chief`, `developer`, `fixer`, `reviewer`, `researcher`, `crosscheck`) is a routing key, not an identity. The role maps to a harness and model only through the routing table passed with `--routing` (`runtime/lib/routing.mjs`). The front Chief session has one id per workspace, stored in `front-chief-session.json` (`docs/front-chief.md`).

**Independent review.** A Gate 1 pass requires a reviewer run as a separate OS process. A single-session review is never a pass (`runtime/lib/reviewer-session.mjs`, `runtime/lib/gates.mjs`). The first line of a review card is the verdict `审查结论：通过 | 打回 | 阻塞`; any other first line is treated as blocked.

**Not identity.** Labels, comment text, ticket wording, and prompt text do not identify a session, role, issue or pull request on their own.

## Pre-dispatch checks

Before an implementer is dispatched, Chief prepares the environment (`npm ci`, or the repository's documented equivalent) in the worktree and verifies that a temporary directory is writable. The implementer must not discover a missing dependency or a read-only temp directory itself.

The preflight (`runtime/lib/preflight.mjs`) checks, in this order, and stops at the first failure. The check is wired by the trusted `--handler` module, which exports `preDispatch`; `runtime/rtd.mjs` `main()` refuses to start (exit 2) without that export. The module supplies `exec` when it calls `runPreDispatch`, so the runtime itself never spawns the prepare command:

1. Every convention file named on the card exists in the worktree and resolves inside it (`missing_convention_file:<name>`, `convention_outside_worktree:<name>`).
2. The card's `baseline` is a `MAJOR.MINOR.PATCH` version equal to the expected baseline (`baseline_invalid`, `baseline_stale`).
3. The card's key numbers equal the source's, with no unknown keys (`numbers_mismatch`).
4. The prepare command succeeds and a temporary directory is writable (`environment_not_ready`, with a stderr tail of at most 2000 characters).

A failed check fails closed: the wake ends as `stop` with class `predispatch_failed` and the reason above, and no implementer runs. When the sandbox has no network, the prepare step fails closed with `environment_not_ready` before the implementer starts, so Chief prepares the dependencies beforehand. Convention: the checks are only as complete as the card's lists.

## Other invariants

- Executors do not commit by default; the Chief commits after a review passes (convention, `.agents/skills/roundtable-work/SKILL.md`).
- A delegation card names the target version, acceptance, allowed files and forbidden actions. Work outside the allowed files is reported, not silently kept (convention, `.agents/skills/roundtable-work/templates/assignment.md`).
- Every Chief turn ends with one continuation decision: `continue`, `wait`, `ask`, `done` or `stop` (`.agents/skills/roundtable-work/prompts/shared.md`).
- Frozen machine contracts (the verdict line, status words, decision words and template placeholders) must not be renamed or translated.

## Changing this file

Change a rule here in the same pull request as the code or instructions it describes. A change to an identity key needs a reviewer to check every caller that builds or parses that key.
