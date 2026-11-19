# Roundtable Work

**Help a team of agents understand a goal, keep making progress, and deliver verifiable results.**

Roundtable Work (`roundtable-work`) is a portable, self-contained engineering loop. One Chief owns the goal and the judgment calls and decides the next step; role sessions (developer, fixer, reviewer, researcher) carry out the work and hand results back through a common set of tickets, assignment cards, delivery cards, and continuation records. The loop's rules live in this repository, so it does not depend on an external assistant service; it does need an agent harness (Claude Code, Codex, pi, or another CLI) to run the sessions. It is distilled from the user's working conventions and research, and from the public prototype of dsh-superagent.

**Status: v0.2.** The installable skill (instructions, templates, and install script) is the default product. The repository also contains an experimental runtime in `runtime/`. It is not installed by the install script, and its behavior is not a default install promise (see [Installable skill and experimental runtime](#installable-skill-and-experimental-runtime)). Nothing in this repository runs as a resident service after installation.

## Install for a Harness

Node.js 24 is required. After getting this repository, install the skill into your workspace:

```bash
git clone https://github.com/Liyuk/roundtable-work.git
cd roundtable-work
node scripts/install.mjs --target /path/to/workspace --dry-run
node scripts/install.mjs --target /path/to/workspace
node scripts/doctor.mjs --target /path/to/workspace
```

What gets installed:

| Location | Purpose |
| --- | --- |
| `.claude/skills/roundtable-work/` | The skill that Claude Code discovers (prompts, templates, references) |
| `.claude/agents/rt-*.md` | Claude Code subagents: `rt-developer`, `rt-fixer`, `rt-reviewer`, `rt-researcher` |
| `.agents/skills/roundtable-work/` | Codex and other harnesses that read the Agent Skills directory |
| `.roundtable/team.md`, `policy.md` | This deployment's roles, authorizations, budget, and stop conditions (they belong to you and are not overwritten on reinstall) |
| `.roundtable/tickets/`, `state/`, `memory/` | Tickets, continuation records, and memory for when the harness has no task system |

To install for only one harness, use `--harness claude` or `--harness codex`; to upgrade, add `--update`. `.roundtable/` may contain project-private information, and whether to commit it is up to you.

Installing only writes files. It does not copy `runtime/`, and it does not start any process.

### Ephemeral load (no install in the target)

To run against a repository that has not installed Roundtable Work, load it into a temp dir for one command:

```bash
node scripts/ephemeral.mjs --target /path/to/repo -- sh -c 'ls "$RT_HOME/.roundtable"'
```

The command runs in the target with `RT_HOME` pointing at a temp dir holding the skill, `runtime/`, `scripts/`, and the default `.roundtable/` config and state. The temp dir is removed when the command exits, including on failure. The target gets no install files or `install.json`; only git worktree metadata from the command is pruned afterwards. The temp dir must be outside the target. Runtime rule files are still read from the repo root you pass to `rtd`.

Then start the harness in the workspace:

- **Claude Code**: run `claude` in the workspace and confirm that `roundtable-work` is in the skill list. Then say "Use roundtable-work to drive this: <goal and acceptance>". The Chief will use the `Agent` tool to assign work to the `rt-*` subagents and use another subagent for independent review.
- **Codex**: run `codex` in the workspace; the skill is discovered from `.agents/skills/`. You can also say directly "Read `.agents/skills/roundtable-work/SKILL.md` and follow it to drive this: <goal>".
- **Other harnesses**: have the agent read `SKILL.md`. Without a sub-session tool, it degrades to a single session and labels the review as a self-check (see the [harness mapping](.agents/skills/roundtable-work/references/harnesses.md)).

For first use, we suggest saying "Use roundtable-work to configure the team" so the agent follows the [setup flow](.agents/skills/roundtable-work/references/setup.md) to check the harness's capabilities and fill in `policy.md`. For the full installation, configuration, and acceptance instructions, see [SETUP](SETUP.md).

To try it inside this repository: `.claude/skills/roundtable-work` is already a symbolic link to the skill source directory, so Claude Code can discover it directly; when you need subagents, run `npm run setup -- --target .` (the generated `.claude/agents/` and `.roundtable/` are not under version control).

## Configuration

There is no single shipped configuration file, and no model is set as a default. Configuration lives in three places:

- **Deployment policy** (`.roundtable/policy.md`, `team.md`): authorizations, budget, roles, and stop conditions. The install script creates them from templates; you own them. The templates set defaults such as 2 attempts per assignment and 2 review rejection rounds, after which only blocking findings stop the work and the rest are listed in the PR body.
- **Routing table** (a JSON file passed as `rtd --routing FILE`): maps each role (`chief`, `researcher`, `developer`, `fixer`, `reviewer`, `verifier`, `security`) to a harness, a model, and a tier, for one time window. The example in [17 Model Routing](docs/17-model-routing.md) uses placeholder names; deployments must put in model IDs they have verified.
- **Environment keys** for the runtime's model router (`RT_ALLOWED_MODELS`, `RT_MODEL`, `RT_REVIEWER_MODEL`, `RT_CROSSCHECK_MODEL`, `RT_DECIDER_MODEL`, and others), listed in [SETUP](SETUP.md#model-and-reviewer-environment-keys). `RT_ALLOWED_MODELS` is required; there is no built-in default.

Roles and tiers in the routing table are the only routing source for prompts. Model names that appear in older practice records are not configuration.

- **Reviewer**: Gate 1 is given the reviewer role's model from the routing table and runs as a separate process.
- **Cross-check (optional)**: Gate 2 runs only for high-risk or triggered diffs, and uses the `reviewer` role. The code does not choose a harness for it.
- **Escalation (optional)**: the decider model (`RT_DECIDER_MODEL`) is used only when a handler exports an escalation adapter, for example after a Gate 2 disagreement. Its attempt budget is `RT_DECIDE_MAX` (default 2).
- **GitHub access**: the runtime calls the `gh` command with the login already present on the host (`scripts/github-read.mjs`). The repository stores no credentials. A GitHub run is in shadow mode unless `--live` is given.

## How the owner uses it

- **File work as issues.** Open a feature or bug issue and label it `type:feature` or `type:bug`. The runtime admits an issue only when it has: a Goal; acceptance criteria with `run:` followed by a backtick-quoted command, and an `expected:` line; an Out of scope section; a Dependencies section; and a Size estimate with `lines:` and `files:` (at most 400 lines and 5 files). Otherwise the runtime does not admit it and reports the missing fields. Loop-created issues (`rt:self`, `rt:followup`) also need `rt:go`. Issues by other authors are ignored.
- **Labels that control the queue.** `rt:hold` pauses an issue. `rt:owner` and `rt:deferred` exclude it. `rt:proposed` keeps it out until `rt:approved` is added.
- **How asks work.** When the runtime needs a decision, it posts a comment with the `<!-- rt:ask -->` marker, adds `rt:ask`, and states one question in one of four categories: scope, credentials, destructive, or direction. It resumes only after the owner replies on that issue, and removes `rt:ask`. Items out of scope use `rt:blocked` instead.
- **Auto-merge after gates.** A change is merged only after Gate 0 (deterministic diff policy, hygiene scan, and sandboxed tests), Gate 1 (independent review), Gate 2 (cross-check, for high-risk work), and green required CI. A single merge entry point then squash-merges it after rechecking the pull request head and the recorded gate evidence. A change to a safety file also needs a recorded owner approval. Merge is never an ask category.

These steps are implemented in the experimental runtime (below). They run only when that runtime is started with a handler and providers.

## Architecture

- **Gate 0** (`runtime/lib/accept.mjs`, `runtime/lib/gate-exec.mjs`): the diff policy, the hygiene scan, and test execution in a sandbox. Any rejection or block fails the gate.
- **Gate 1** (`runtime/lib/reviewer-session.mjs`, `runtime/lib/gates.mjs`): the reviewer runs as a separate OS process (default `pi -p`, set with `RT_REVIEWER_COMMAND`). Its first line must be the verdict `Verdict: pass | reject | block`; any other first line is blocked. A single-session review never passes Gate 1.
- **Gate 2** (`runtime/lib/gate2-triggers.mjs`): a cross-check for high-risk work and for diffs that trigger it. A disagreement goes to the escalation adapter, not back to the developer.
- **State machine** (`runtime/lib/state.mjs`, `runtime/rtd.mjs`): each issue moves through the phases `developing → testing → reviewing → finalizing`. A wake ends in a recorded status such as `waiting_external`, `waiting_person`, or `done`. The `finalizing` phase is never silently re-run after a crash.
- **Auto-claim and recovery** (`runtime/lib/claim.mjs`): a claim is the `rt:running` label plus the `<!-- rt:claim -->` marker, guarded by a per-issue lock with a time-to-live. Stale claims are recovered.
- **Parallel work** (`runtime/lib/workers.mjs`): `--workers N` (default 2) runs issues in parallel, each with its own lock and, in GitHub runs, its own worktree. Work on the same series or with dependencies is not run in parallel.

Each part is described in more detail in [operator guide](docs/operator-guide.md) and [01 Overall Plan](docs/01-architecture.md).

## Installable skill and experimental runtime

These are two different things. Only the first is installed by default.

| | Installable skill | Experimental runtime (`runtime/`) |
| --- | --- | --- |
| Installed by `scripts/install.mjs` | Yes | No |
| Starts a process | No | Only when an operator runs it |
| Behavior promised by default | Yes, as instructions, templates, and subagents that a harness follows | No. Prototype behavior, not a default install promise |

**How the runtime is started.** `rtd.mjs` runs one pass over the queue and exits. Each runnable issue gets at most one wake in that pass. An example invocation, with placeholders:

```bash
node runtime/rtd.mjs --work-root <work-root> --github --repo <owner/repo> --repo-root <repo> \
  --handler <handler-module> --providers <providers-module> --routing <routing-file>
```

- It needs a **trusted handler module** (operator code that performs each phase through a harness) and a **providers module** (gate, GitHub, and git providers). Neither is confined to the work root. A GitHub run needs the `gh` login on the host and `--routing`.
- It needs an **external wake**: something outside `rtd` (a scheduler, a timer, or an operator) must run it again. Nothing in this repository schedules it.
- **Install does not start a daemon.** The systemd units in `deploy/systemd/` are templates. They are not installed or enabled by any script, and `rtd.service` has no `[Install]` section. The owner replaces every `<placeholder>`, then enables the unit.
- The supervisor (`runtime/supervise.mjs`) is observe-only. It reads a heartbeat file, and nothing in this repository writes that file. The front Chief launcher (`bin/rt-chief.mjs`) starts a session only when `RT_AGENT_BIN` is set.
- Shadow mode is the default for GitHub runs. Add `--live` only for intended writes.

**Not a default promise.** The following are unverified, unwired, or owner-only, and should not be relied on: background wake-up after a turn ends; the heartbeat producer; rollback to a release that already exists (the CLI points `current` only at a newly exported commit); resuming a Codex session by stored id; event-driven intake (`outbox`, event timers, and event inbox modules are not wired into `rtd`); and any release tag, host cut-over, or lingering setting, which are owner steps. [Operator guide](docs/operator-guide.md) lists what the code does and does not do, and [supervisor](docs/supervisor.md) describes the heartbeat.

## Project contracts

Project contracts and invariants, including the identity-key rules for issues, claims, sessions, roles, and pull requests, are in [docs/project-contracts.md](docs/project-contracts.md). Assignment cards and review checklists should cite it by path and section.

## Core principles

- People provide direction and authorization; the team decides the next step on its own within scope, and interrupts people only when a judgment is truly needed.
- The end of a turn does not mean the goal is complete; sent, claimed, executed, delivered, and accepted are different facts. Every turn ends with a continuation record: `continue / wait / ask / done / stop`.
- Personas and prompts describe behavior; permissions, budget, task state, and safety boundaries are enforced by the harness and the runtime.
- Proactive discovery and improvement are allowed, but only with a source, authorization, a budget, deduplication, acceptance criteria, and explicit stop conditions.
- Reuse the harness's existing capabilities; each piece of work has exactly one authority for scheduling and state.

## Design documents

The [documentation index](docs/README.md) lists all design documents and practice records by topic. We suggest reading the [overall design](docs/01-architecture.md), [single harness first](docs/15-single-harness-communication.md), and [prompts and engineering](docs/14-prompt-to-runtime.md) first.

## Project maintenance

Use Node.js 24 to run `npm ci` and `npm test`: the tests cover the install script and diagnostics, and check local Markdown links and that the skill directory does not link outside itself. `npm run doctor` is a read-only check of Node, Git, and candidate harness commands; add `--target <workspace>` to check the installation result, and `--json` to output machine-readable results. Diagnostics do not check model login and cannot prove that background wake-up or persistent delegation works. For the workflow and how to contribute, see [CONTRIBUTING.md](CONTRIBUTING.md). The project is licensed under the [MIT License](LICENSE).
