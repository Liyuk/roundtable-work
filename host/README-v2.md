# rt-loop v2 operator guide

Copy the files in this directory **as a whole to `~/rt-loop` (the same path, so existing worktrees stay valid)**. All scripts derive the root from their own location or the `RT_HOME` environment variable; nothing is hard-coded to `rt-loop-next`. Do not copy `SPEC.md`/`ADDENDUM*.md`/`test/`/`.build-session`/`build*.log`. Before copying `config.env`, confirm whether existing live changes to it must be kept. Before deploying, stop the old `rt-loop.sh` first (it does not use `locks/<n>.lock`, and the two cannot run side by side).

GitHub intake + autonomous decisions + parallel workers. `rt-loop.sh` / `queue.txt` are kept as the legacy version; **v2 does not use them**.

## Components
| File | Role |
| --- | --- |
| `rt-sched.py [--dry-run] [--once]` | Long-running scheduler: one round every `RT_POLL` seconds (finalize → ask resume → pull issues → claim → orphan recovery → heartbeat) |
| `rt-work.sh <n> [base]` | Single-issue worker: worktree `wt/<n>`, branch `rt/<n>-pi`, Chief wake loop + post-processing (decide/decompose/ask/gates/labels), holds `locks/<n>.lock` |
| `bin/rt-gate0 <wt> <base> <n>` | Gate 0 (deterministic): npm test, privacy, frozen-field count (`gate0-frozen.txt`), translation direction, tests not weakened. `--scan-text <file>` runs a plain-text privacy scan |
| `bin/rt-xcheck <wt> <base> <n>` | Gate 2: `codex exec --sandbox read-only`, first line `XCHECK: pass|fail|unavailable` |
| `bin/rt-decide <n> <question-file>` | Opus decider, first line `DECIDE: resolve|ask-owner|stop`; decides only, does not implement or review |
| `bin/rt-labels-init [-n]` | Creates missing labels (existing ones are skipped; `-n` only lists). **The deployer runs it once by hand** |
| `bin/gh` | Restricted gh for the pi side: read-only + `pr create/edit` + comments (comments automatically get the `<!-- rt:chief -->` marker); no label/close/merge/ready |
| `bin/rt-merge <pr>` | **The only place** that merges (no `--admin`/`--auto`). The squash is routed by `outbox-bridge.mjs merge` through the durable outbox: the merge item is enqueued before `gh pr merge --squash` runs, then the `done-pending-confirmation` notice is enqueued and delivered once the merge is delivered. Requires `RT_MERGE_STEP=1` + `wt/<n>/.roundtable/state/gates.json` all green and head matching the PR; re-checks PR state before merging. `RT_DRY_RUN=1` only prints. Exit codes: 0 merged/will merge, 2 refused, 3 skipped (already merged/closed/hands-off), 5 must sync main, 6 CI not green, 7 main red |
| `bin/rt-sync-branch <n>` | **Merges** `origin/main` into `rt/<n>-pi` and does a normal push (no rebase, no force); on conflict it aborts and writes SUPERVISOR.md |
| `bin/rt-revert <sha>` | When main CI is red and the head commit is an auto-merge product: creates `rt/revert-<sha7>`, opens a PR, waits for CI, merges via rt-merge, comments on the original issue, and opens a new `rt:self` `type:bug` `priority:p0` issue |
| `bin/rt-safety` | Safety-file detector (file names from stdin/arguments → list of hits; exits 1 on a hit) |
| `bin/rt-state <n> get/set/inc/reset` | Per-issue persistent counters in `state/issues/<n>.json` (decide_n, fix_n, review_n, safety_n, merge_hold) |
| `bin/rt-tree <dir>` | Git tree ID of the worktree content, used to prove "the reviewed object is the current head" |
| `bin/rt-wt <n> [base]` | Creates/reuses a worker worktree |
| `status.sh` | Health check |
| `test/run-all.sh` | End-to-end tests with fake gh/pi/codex (writes only to local bare repositories, never touches GitHub) |

## Model routing (`config.env`)
The only source of model routing is `config.env`. At each role start, `bin/rt-agent` generates the "routing facts" block (each role's harness and model, plus `RT_NOFUNDS_MODEL` for when DeepSeek has no funds) and injects it into the system prompt. `bin/rt-agent --routing-facts` shows it; `bin/rt-agent --check` verifies that every role has a model configured (start-box.sh runs it before startup). Prompts and policy files only name tiers (developer tier, reviewer tier, decider tier), never model names.

## Role memory preload (#605)
`RT_ROLE_MEMORY=1` makes `bin/rt-agent` append the role's preloaded memory to the prompt of each new role start, under a `## Memory` heading. The section is what `rtd` appends for the same role (`appendMemory` in `runtime/rtd.mjs`, `preload` in `runtime/lib/role-memory.mjs`): active layer-3 rules, then layer-2 index lines, capped at `LIMITS.preloadChars` (2000 characters). `bin/rt-role-memory.mjs` is the host helper; it has no copy of the cap or the heading format.
- Default: `0` (off). With `0`, or when the store is empty or missing, the prompt is unchanged and the launch is unaffected. If the helper fails, rt-agent prints a warning and launches with the original prompt.
- `RT_ROLE_MEMORY_DIR`: the store directory (`memory.jsonl`). Empty means `$RT_HOME/state`, the same `<work-root>/state` that `rtd` uses. `rtd` and the host share the store when both point at the same state directory.

## Deployment (done by the deployer; not executed in this directory)
1. `bin/rt-labels-init -n` to see the list, then `bin/rt-labels-init` to create the labels.
2. First run `RT_HOME=$PWD ./rt-sched.py --dry-run --once` to see the decisions (read-only, writes nothing to GitHub).
3. After the old `rt-loop` is stopped (`touch ~/rt-loop/STOP`, and wait for its workers to finish), run `./rt-sched.py` in tmux. Terminal states from the old `status.tsv` (done/stop/…) are carried over; new owner comments reopen them.
4. `./status.sh` shows status. To stop: `touch STOP` (the scheduler stops claiming and exits only after workers finish; **it does not kill workers**). SIGTERM/Ctrl-C only exits the scheduler; workers continue (after a restart they are reclaimed from `locks/`).

## Gate 2 (high-risk second pass)
Gate 2 is the second pass of the reviewer role (`bin/rt-xcheck`, reviewer model from `rt-window --model reviewer`). It runs only when `bin/rt-risk <wt> origin/<base> <issue-title>` prints a reason; a low-risk diff gets one review pass (Gate 1) only. Triggers, checked in this order:
- Paths: `scripts/`, `.github/`, `runtime/`, `.agents/skills/`, `profiles/`, and any `templates/` path.
- Path words (case-insensitive, any changed file name): `auth` (authentication), `secret` / `credential` / `token` (secrets), `network` / `proxy` / `webhook` (network), `intake` (external input), `deploy` (deployment).
- High blast radius: more than 400 changed lines (added + deleted, `git diff --numstat`).
- Issue title containing `I18N`.

## Automatic merge (owner decision)
done → Gate 0 → (high-risk) Gate 2 → **Gate 1: must be a `审查结论：通过` verdict from Sonnet on the file tree of the current head** (`rt-delegate reviewer` records the verdict and tree ID to `wt/<n>/.roundtable/state/reviews.log`; if there is none, the worker runs `rt-delegate reviewer` once itself, with the card built from the issue body and `git diff base...HEAD`; reject → fix round; unavailable → retry once, and if still unavailable only label `rt:ready-to-merge`, do not merge, and log it) → write `gates.json` and PR comment `<!-- rt:gates -->` (containing `Result: pass` and `Head: <sha7>`) → for safe files go to Opus (`APPROVE-MERGE`, after first posting the `<!-- rt:opus-merge -->` comment; otherwise leave it to the owner) → `gh pr checks --watch --required` (`RT_CI_TIMEOUT`; red or timeout = Gate failure → fix round; no required checks → no merge) → `bin/rt-merge`. After merge: the merge, the `done-pending-confirmation` notice and any rollback go through the durable outbox (`host/outbox-bridge.mjs`, `runtime/lib/merge-outbox.mjs`), not direct gh calls; the notice id is `notice:merge:<pr>:<head>`, so a replayed cycle does not notify twice. `applyMergeReply` (`runtime/lib/merge-outbox.mjs`) is an available handler for the owner's `/rt confirm merge:<pr>:<head>` and `/rt rollback merge:<pr>:<head>` replies, but it is NOT yet called by the host loop's reply path, so live owner confirm/rollback replies are not processed yet. When it is called, only a merge whose notice has been delivered is accepted, anything else is ignored and changes nothing; a rollback enqueues one `rollback:merge:<pr>:<head>` item, delivered by the bridge through `bin/rt-revert`, and a second request for the same merge is refused. `rt:merged`; stacked successor branches run `git merge origin/main` with a plain push and change the PR base back to main (conflict → abort, write SUPERVISOR.md, set status queued to wake Chief). `RT_AUTOMERGE=0` disables it entirely; PRs in `RT_HANDS_OFF_PRS` are not touched.
Stacking: a dependency issue that is CLOSED counts as satisfied. A dependency PR that is only `rt:ready-to-merge` (waiting on CI/merge, and not left for the owner) can still be used as a fallback base, but a stacked PR is not merged until its base PR has merged.

## PR sweep (ADDENDUM2)
Each scheduler round, before claiming, scans all open `rt/<n>-*` PRs (excluding `rt:merged`/`rt:blocked`, no active worker, issue open and not held/asked). If the head has no passing gates record (`gates.json` or a passing `<!-- rt:gates -->` comment), it starts `rt-work.sh <n> --gate-only` (taking one worker slot): reuses/creates the worktree, merges main if behind, runs Gate 0/1/2, waits for CI, and merges. On failure or conflict it falls back to a normal Chief wake with SUPERVISOR.md. Transient holds (base not merged, main red, sync) are retried after a backoff (`RT_SWEEP_RETRY`, default 900s); `owner:*` holds are not touched. Terminal states from the old loop (e.g. #16 `stop`) stay terminal unless the owner comments afterwards.

## main red
Each round, read the most recent completed CI on main: red → `state/main_red`, which pauses new claims and merges (revert excepted); if the head commit is in `state/merges.log` (merged by us automatically) → start `bin/rt-revert`. Green → cleared automatically.

## Labels
`type:feature|bug`, `priority:p0|p1|p2`, `rt:running` (claimed / has a worker), `rt:ask` (waiting for owner reply), `rt:self` (sub-issue split off by the loop), `rt:proposed`+`rt:approved`, `rt:ready-to-merge` (gates passed; auto-merged after CI is green, or left to the owner because of a safety file / Gate 1 unavailable / no required checks, etc.), `rt:merged` (merged by the loop), `rt:blocked` (stopped; a reply resumes it), `rt:hold` (split; automatically released once all sub-issues are closed), `rt:owner` (for the owner only, not claimed). `rt:go` is a legacy label and is ignored.

## Decision flow (worker)
- Chief DECISION: `continue|wait|ask|done|stop|decompose|out-of-scope`. For `ask`, line 2 is the category (`scope|credentials|destructive|direction`; there is no merge), and line 3 onward is the question.
- `ask`: `credentials|destructive` go straight to the owner via `<!-- rt:ask -->`; `scope|direction` or an invalid category (including the cancelled `merge`) → first `rt-decide` (`resolve` writes SUPERVISOR.md and wakes once more; at most `RT_DECIDE_MAX=2` times per issue, count persisted, reset after an owner reply).
- `stop` / no progress (2 consecutive wakes with no change) / wake budget (`RT_MAXWAKE`) exhausted: ask the decider once; `resolve` wakes again, otherwise `rt:blocked` + a comment with the reason.
- `decompose`: creates `rt:self` sub-issues from `state/subissues/NN-*.md` (`sub:NN` is replaced with the real number), and the parent issue gets `rt:hold`. After all sub-issues close, the scheduler releases the hold and wakes the parent issue to check acceptance (DECISION `done` + line 2 `no-pr`). The sub-issue list is in `state/children/<parent>`.
- `wait`: line 2 is the reason; optional line 3 `unblock_at <ISO 8601 time>` (default: now + `RT_WAIT_SLEEP`, 300 s). The worker writes a due timer through `waitRelease` (`state` file `.roundtable/state/timers.json`), sets the issue to `waiting`, drops `rt:running` and **exits**, so its slot and `locks/<n>.lock` are freed. It is not claimed again until an unacked inbox event routed to the issue arrives (see "Event triggers and wait release"). If the timer cannot be written, the worker keeps its wake loop.
- `out-of-scope`: comment + `rt:blocked` (not closed; only `rt:self` sub-issues created by the loop itself are closed).
- `done`: see "Automatic merge" above. Gate 0 privacy/test failures can never be overridden; they only go to fixes (at most 2 rounds, persisted). Disagreements between Gate 0/2 and Gate 1 are judged by Opus as `VERDICT: real|false-positive` (overriding requires Gate 1 to pass). XCHECK `unavailable` does not block.
- All text a worker sends to GitHub passes the privacy scan first; if it fails, it is replaced with generic wording and logged.

## Event triggers and wait release
Every trigger becomes one event in the inbox (`.roundtable/state/event-inbox.jsonl`), de-duplicated by `source_event_id`. Timers live in `.roundtable/state/timers.json`; routed events are acked in `acked.jsonl`. Paths are under `RT_HOME`.

**Host wiring (each `rt-sched.py` cycle, in order):** `fire_timers` runs `node bin/rt-timers.mjs <RT_HOME>`, which fires every due timer into the inbox (skipped on `STOP` or during the cycle-gap hold); `resume_waits` queues each `waiting` issue that has an unacked inbox event routed to it; then the claim step starts queued issues like any other candidate. A `waiting` issue with nothing routed is skipped ("waiting for its timer or awaited event").

**Trigger kinds** (`KINDS` in `runtime/lib/event-inbox.mjs`):
- `heartbeat`: wait-release timers (`wait:<n>:resume`, written by `rt-work.sh`) and the daemon's patrol timer.
- `timer`: a generic `once` or `recurring` timer whose event has kind `timer`. None is registered by default.
- `ci`, `owner_comment`, `intake`: produced by `runtime/lib/daemon-events.mjs` (`produceEvents`), which only the daemon runtime calls. The host scheduler does not produce them.
- `webhook`: `runtime/lib/webhook-listener.mjs`, a signed-POST listener that binds `127.0.0.1` by default. It is **default-off**: nothing in `host/` or the daemon starts it, and enabling it is an explicit operator action. It is not enabled by this change.

**Wait release (`waitRelease`, `runtime/lib/event-timers.mjs`):** the timer id is `wait:<issue>:resume`, its `at` is `unblock_at`, and it fires an event with `kind: heartbeat` and `issue: <n>`. When it fires, its `source_event_id` is `timer:wait:<n>:resume:<at>`, and the inbox drops a replay of that same firing. The issue resumes through the claim step, and a resumed worker continues from its Chief session. The awaited event (for example a CI result for the issue) resumes it the same way, before the timer is due. Each routed event wakes the issue once.

**Tests:** `test/host-wait-release.test.mjs` (fixtures; no network, no real clock) covers the timer, the replayed firing, the CI resume, the scheduler skip and resume, and a worker `wait` in a sandbox that exits with its lock free.

## Scheduling rules summary
Candidates: owner-authored, not `[Owner]`/epic, no excluded label, no open PR on `rt/<n>-*` (unless resuming from ask), not terminal, dependencies satisfied (dependency issue CLOSED, or exactly one `rt:ready-to-merge` dependency PR → stack on its branch as base; more than one → wait). Issues in the same series (first `[..]` prefix) and issues with dependencies are mutually exclusive. Ordering: bug → priority → `rt:self` → creation time. `--dry-run` only prints `DRY would claim` / `DRY skip #n: reason`.

## State files
`status.tsv` (n state wake updated detail; same format as before; shares the flock on `state/status.lock`), `state/heartbeat`, `logs/sched.log`, `logs/work/<n>-<ts>.log`, `logs/gates/`, `logs/decide/`, `logs/chief/`, `locks/<n>.lock|.info`, `state/base/<n>`, `state/children/<n>`, `state/issues/<n>.json`, `state/merges.log`, `state/main_red`, `state/reverted/`.

## Known limitations
See the delivery report: the Gate 0 privacy scan exempts only generic secret-shape kinds (those listed in `SECRET_SHAPE_KINDS` in `bin/rt-gate0`) for files under `test/`; the same kinds of strings in other paths (such as `scripts/validate-site.mjs`) still raise warnings and cannot be overridden by the decider. The real pi/codex/Opus chains have only been tested with fake gh/pi/codex stubs (see `test/run-all.sh`).
