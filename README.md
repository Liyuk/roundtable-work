# Roundtable Work

**Help a team of agents understand a goal, keep making progress, and deliver verifiable results.**

Roundtable Work (`roundtable-work`) is a way of working that installs into an existing agent harness (Claude Code, Codex, and others): one Chief owns the goal and the judgment calls, while roles such as developer, fixer, reviewer, and researcher execute in independent sessions and hand work off through a common set of tickets, assignment cards, delivery cards, and continuation records. It is distilled from the user's working conventions and research, and from the public prototype of dsh-superagent.

**Status: v0.2 · an installable skill and configuration; there is no background runtime.** After installation, the team operates inside one active session; whether it can be woken automatically after a turn ends depends on the harness, and this cannot be promised without testing.

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

Then start the harness in the workspace:

- **Claude Code**: run `claude` in the workspace and confirm that `roundtable-work` is in the skill list. Then say "Use roundtable-work to drive this: <goal and acceptance>". The Chief will use the `Agent` tool to assign work to the `rt-*` subagents and use another subagent for independent review.
- **Codex**: run `codex` in the workspace; the skill is discovered from `.agents/skills/`. You can also say directly "Read `.agents/skills/roundtable-work/SKILL.md` and follow it to drive this: <goal>".
- **Other harnesses**: have the agent read `SKILL.md`. Without a sub-session tool, it degrades to a single session and labels the review as "self-check" (`自查`).

For first use, we suggest saying "Use roundtable-work to configure the team" so the agent follows the [setup flow](.agents/skills/roundtable-work/references/setup.md) to check the harness's capabilities and fill in `policy.md`. For the full installation, configuration, and acceptance instructions, see [SETUP](SETUP.md).

To try it inside this repository: `.claude/skills/roundtable-work` is already a symbolic link to the skill source directory, so Claude Code can discover it directly; when you need subagents, run `npm run setup -- --target .` (the generated `.claude/agents/` and `.roundtable/` are not under version control).

## Runtime package (Skill)

All runtime instructions live in [`.agents/skills/roundtable-work/`](.agents/skills/roundtable-work/SKILL.md), which can be copied as a whole into any workspace:

- Instructions: [Shared behavior](.agents/skills/roundtable-work/prompts/shared.md) · [Chief](.agents/skills/roundtable-work/prompts/roles/chief.md) · [Developer](.agents/skills/roundtable-work/prompts/roles/developer.md) · [Fixer](.agents/skills/roundtable-work/prompts/roles/fixer.md) · [Reviewer](.agents/skills/roundtable-work/prompts/roles/reviewer.md) · [Researcher](.agents/skills/roundtable-work/prompts/roles/researcher.md)
- Templates: [Ticket](.agents/skills/roundtable-work/templates/ticket.md) · [Assignment card](.agents/skills/roundtable-work/templates/assignment.md) · [Delivery card](.agents/skills/roundtable-work/templates/delivery.md) · [Continuation record](.agents/skills/roundtable-work/templates/checkpoint.md) · [Team](.agents/skills/roundtable-work/templates/team.md) · [Policy](.agents/skills/roundtable-work/templates/policy.md) · [Role creation card](.agents/skills/roundtable-work/templates/bot.md) · [Memory candidate](.agents/skills/roundtable-work/templates/memory.md)
- References: [Harness capability mapping](.agents/skills/roundtable-work/references/harnesses.md) · [Setup flow](.agents/skills/roundtable-work/references/setup.md) · [Skill discovery](.agents/skills/roundtable-work/references/skill-discovery.md)

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
