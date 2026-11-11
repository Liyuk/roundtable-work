# Sonnet A/B rehearsal: v0.2 design vs the original design

Date: 2026-11-10. Harness: Claude Code desktop. Two independent Sonnet (`claude-sonnet-5-5`) app-level sessions each acted as Chief, using the same goal on copies of the same fictional repository `textkit`. The Chief and all subagents were Sonnet; the evaluation was done by another main session reading the artifacts and the two self-reported accounts. No one answered questions during the run.

## Setup

- Goal (verbatim): "Maintain the textkit project: fix ISSUE-12, implement FEATURE-13, and update the README in sync; in the end `npm test` must fully pass, and every change must have a corresponding test. Do not push, do not publish."
- Fixture: `slugify` has a bug with consecutive separators and leading/trailing `-`; add `truncate`; FEATURE-13 contains an open product question (count by grapheme or by UTF-16 code unit).
- **v0.2 group**: installed with `install.mjs --harness claude`; the session was opened in this repository, the skill was discovered through the `.claude/skills` symbolic link, and the `rt-*` subagents were available; the workspace also had `.roundtable/team.md` and `policy.md`.
- **Baseline group**: the original design was exported from commit `733bb23`, and the Chief was told to read its `SKILL.md`; use of the v0.2 skill and the `rt-*` subagents was forbidden, and generic subagents were used. The description of the v0.2 skill was still visible in the session's skill list, so there is slight contamination.

## Results (independently verified)

| Item | v0.2 | Baseline |
| --- | --- | --- |
| Final `npm test` | 22/22, exit 0 (re-run by the evaluator) | 16/16, exit 0 (re-run by the evaluator) |
| Goal completion | Both items completed and independently reviewed; two commits on a feature branch | Both items completed and independently reviewed; not committed, with a diff fingerprint locking the reviewed version |
| Delegation | `rt-fixer`, `rt-developer`, `rt-reviewer`×2, in parallel in the background | Generic subagents ×3, plus 1 documentation rework and 1 re-review |
| Open question | Defaulted to grapheme, annotated in the code; continuation record `ask`: suspends only Q1, the rest done | Same default and annotation; the ticket was recorded as `ready` + `waiting_person` |
| Continuation records | Two checkpoints, first and last; intermediate turns written in the ticket | One hand-written work record |
| Out-of-bounds writes | The developer wrote a log to `/tmp` once, self-reported, cleaned up by the Chief | The reviewer left 4 temporary directories and logs in `/tmp`, not treated as a problem (the original design has no such rule) |
| Design files read | Files inside the skill directory, no broken links | About 11 files; `SETUP.md` and `npm run doctor` do not exist in the exported directory (the original skill is not portable) |

Both groups managed to: split the task and run in parallel, keep authors and reviewers separate, have reviewers prove the tests effective with mutation or revert experiments, ask only about the open question while doing the rest, and not fabricate results. At this task scale, Sonnet could deliver under either design; the differences were mainly in portability, records, and clarity of boundaries, not in final code quality.

## Observations on harness capabilities

- After a background subagent completed, the harness handed the completion notification to the Chief as a new turn; both groups relied on it to run multi-step work to the end without anyone prompting. This is continuation within the same app session; closing or restarting the app, or waking across days, was not tested.
- The receipts were only "started / completed", so `delivered / acknowledged` could not be confirmed separately (both groups reported this).

## Revisions made as a result (v0.2.1)

The overlapping or actionable parts of the two groups' reports of friction have been improved in the skill:

- Executors do not commit by default; after review passes, the Chief commits on a feature branch; `policy.md` allows this by default.
- Temporary files are uniformly placed in `.roundtable/scratch/<assignment>/`; the Chief checks for out-of-bounds writes at acceptance.
- How to record delegation events when there are only two kinds of receipt; a harness error before sending does not count as an attempt.
- The overall continuation decision when multiple items are in different states (such as "ask: Q1; the rest done"), and the notation for "satisfied by default (pending confirmation)" (`按默认已满足（待确认）`).
- Handling of non-blocking suggestions, when changes after review must be re-reviewed, and the line between the Chief's verification and execution.
- The continuation record is written in full only on the first turn, when the decision changes, and on the last turn; a lightweight mode is added.
- Delegation goes to in-process subagents by default; when the session directory differs from the workspace, the card writes absolute paths.

The revised version has not yet been run through another A/B.
