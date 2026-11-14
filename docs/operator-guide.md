# Operator Guide

This guide covers what an operator can do with the runtime: run it in shadow mode, read the heartbeat, pause work, roll back the `current` release, understand the proposal flow and merge-risk labels, and the steps that only the owner performs.

Each section names the code it describes. Anything not found in the code is marked as such.

## Shadow run

A GitHub run is in shadow mode unless `--live` is given. [rtd.mjs](../runtime/rtd.mjs) sets `shadow = args.github && !args.live`. In shadow mode, [shadow.mjs](../runtime/lib/shadow.mjs) wraps the GitHub client so that only read methods are forwarded. Every other method is a no-op that resolves without writing to GitHub.

```sh
node runtime/rtd.mjs --work-root <work-root> --github --repo <owner/repo> --repo-root <repo> \
  --handler <handler-module> --providers <providers-module> --routing <routing-file>
```

What a shadow run writes:

- Local state under `--work-root`.
- One file per pass, `<work-root>/shadow/cycle-<n>.jsonl`. Each line is a decision that differs from the live decisions given with `--live-decisions FILE`. The file is empty when there are no differences.

Nothing is posted, labelled, merged or closed on GitHub. Pass `--live` only when you intend live writes; without it the run is shadow.

The supervisor has its own observe-only mode, described in [supervisor.md](supervisor.md). `runtime/supervise.mjs --mode observe` (the default) reads a GitHub fixture file and records decisions in `<workspace>/.roundtable/state/supervisor-ledger.jsonl`. It does not act. It makes no network calls.

## Reading the heartbeat

The supervisor reads `<workspace>/.roundtable/state/heartbeat.json`. The field names and allowed values are defined in [supervisor.md](supervisor.md#schema):

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Must be `1`. |
| `writtenAt` | Epoch milliseconds when the file was written. |
| `daemon.pid` | Daemon process id. |
| `daemon.lastCycleAt` | Epoch milliseconds when the last daemon cycle ended. |
| `daemon.state` | `running`, `stopping` or `stopped`. |
| `frontChief.session` | Front Chief session name. |
| `frontChief.lastTurnAt` | Epoch milliseconds when the last front Chief turn ended. |
| `frontChief.state` | `active`, `idle` or `gone`. |
| `lastMaterialProgress` | `null`, or an object with `kind` (`commit`, `verdict`, `pr`), `at` and `ref`. |

A missing file is reported as `missing`. Malformed or invalid content is reported as `malformed` or `invalid-schema`. The parser never throws; see [supervisor.md](supervisor.md#parser-result).

Note: this repository has the reader (`runtime/supervise.mjs`) and the writer function (`writeHeartbeat` in `runtime/supervisor/heartbeat.mjs`). No module in this repository calls `writeHeartbeat`, so the file is not produced by the code here. Check that the file exists and is recent before you trust it.

## Pausing work

The code has two operator mechanisms. Nothing else is available.

### 1. Hold an issue with `rt:hold`

- Effect: the queue reader in [intake.mjs](../runtime/lib/intake.mjs) excludes any open issue labelled `rt:hold`. The check is applied when the queue is read, so the issue is not picked up by a later pass.
- To pause: add the label on GitHub.
- To resume: remove the label on GitHub.
- The runtime removes this label by itself only when a decomposition has released its child issues. It does not check or use the label otherwise.
- This does not interrupt a wake that is already running. The code does not show that it stops one.

### 2. Clear a main hold

When the auto-merge monitor cannot resolve a merge outcome, it records a main hold. Claims and merges stay paused until the hold is cleared. The monitor opens a GitHub issue for the manual check, titled "Manual merge-outcome check required ...".

```sh
node runtime/rtd.mjs --work-root <work-root> --providers <providers-module> --clear-main-pause
```

- Effect: clears the persisted `mainMonitor` record and, when the providers module exposes `pause`, the pause backend. It prints `{"status":"ok","cleared":<bool>}` and exits 0. It is a no-op success when nothing is set.
- It takes the same lock as a pass. If another pass holds the lock, it prints `{"status":"locked",...}` and exits 75. It clears nothing in that case.
- It does not check the pull request or `main`. Check them first, as the issue text asks.
- It does not close the escalation issue. Close that issue by hand.
- It does not remove labels from any issue.

### 3. Not available

- `validPause` and `resumeFromPause` in [machine.mjs](../runtime/lib/machine.mjs) are not an operator mechanism. Nothing imports them, so they have no effect on a run. Do not use them.
- There is no global pause flag and no runtime control API. The supervisor cannot start, stop or message the daemon or the front Chief session.

## Rolling back `current`

[scripts/release.mjs](../scripts/release.mjs) exports a git commit to `<base>/releases/<sha>`. With `--point-current` it also points `<base>/current` at that release.

```sh
node scripts/release.mjs --base <base> --sha <rev> --point-current           # dry run (default)
node scripts/release.mjs --base <base> --sha <rev> --point-current --apply   # writes
```

- `--base` defaults to `$XDG_DATA_HOME/rtd`, or `~/.local/share/rtd` when `XDG_DATA_HOME` is unset.
- `--sha` defaults to `HEAD` and is resolved to a full commit SHA.
- Without `--apply` the script prints the plan and writes nothing.
- With `--apply`, the export fails if `releases/<sha>` already exists. Export and pointing are separate steps in the code, so `--point-current` only succeeds for a commit that has not yet been exported.
- `--point-current` first requires `current` to be absent or a symlink. It then replaces the link atomically (`replaceCurrentLink` in [release.mjs](../runtime/lib/release.mjs)).
- The script stops and restarts no process.

Limits:

- There is no command for re-pointing `current` at a release that already exists in `releases/`. `replaceCurrentLink` is not exposed by the CLI. Rolling back to such a release is not covered by the code in this repository.
- `resolveCurrentRelease` checks that `current` resolves to `releases/<sha>`. It is a library function; the CLI does not call it.

Owner-only: `--apply` (with or without `--point-current`) changes the host. Dry runs are safe for anyone.

## Proposal flow

An issue labelled `rt:proposed` is not picked up while it lacks `rt:approved`.

- In [intake.mjs](../runtime/lib/intake.mjs), a `rt:proposed` issue without `rt:approved` is skipped. The exception is an issue that is already recovering (labelled `rt:running`, `rt:ask` or `rt:blocked`).
- Adding `rt:approved` makes the issue eligible again, subject to the other queue rules (for example, `type:bug` or `type:feature`, or `rt:go` for loop-created issues).
- [machine.mjs](../runtime/lib/machine.mjs) `pickQueue` drops every `rt:proposed` issue, approved or not. Nothing in the production queue path calls it (its header says so).

So the behaviour that holds in the code is: `rt:proposed` alone keeps an issue out of the queue; `rt:approved` lets it in. Do not describe it as never runnable.

## Merge-risk labels

[merge-risk.mjs](../runtime/lib/merge-risk.mjs) `mergeRisk({ paths, changedLines, ci, reviewDisagreement })` returns `{ label, reasons }`:

| Label | When |
| --- | --- |
| `risk:high` | A safety file changed (hooks, `bin/gh`, limits or policy files, guard, CI workflows, `scripts/check.mjs`), or review disagreement is set. |
| `risk:medium` | More than 400 changed lines, or a protocol file changed (`config.env`, `package.json`, templates or prompts, verdict, classify, decide or review-ledger modules). |
| `risk:low` | Otherwise. |

If CI is not green, the level goes up by one, capped at `risk:high`. The `reasons` array lists each trigger, such as `safety-file:<path>` or `ci-not-green`.

The helper is pure. It does not merge anything and does not write GitHub labels. Nothing in this repository calls it outside its tests, so the labels are not applied automatically.

## Owner-only steps

These steps are for the owner. The loop and operators must not run them. This repository contains no script that performs them, and the code does not verify them. Record the result of each step outside the repository.

1. **Tag `rtd-v*`**: create a release tag for the daemon. No code here creates or checks tags.
2. **Enable units on the host**: the templates in `deploy/systemd/` are not enabled or installed by any script. The owner replaces every `<placeholder>`, installs the unit, and runs `systemctl --user enable` for it. `rtd.service` has no `[Install]` section.
3. **Cut over from `$RT_HOME`**: switch the host from the previous install in `$RT_HOME` to the new release. No code here does this.
4. **Enable lingering** for the service user, so that user units keep running without a login session. No code here does this.

Also owner-only: the `--apply` step of the rollback above, and any live run (`--live`).
