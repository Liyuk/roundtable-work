# Setup: install Roundtable Work into a harness

> Implemented: installing the skill (prompts, templates, Claude Code subagents) into a workspace and generating the `.roundtable/` configuration. Not implemented: background scheduling, automatic wake-up after a turn ends, and recovery across restarts. When this is handed to a coding agent to carry out, it must report actual results, and a capability that has not been verified must not be written up as available.

## 1. Installation (executable)

Node.js 24 and a copy of this repository are required.

```bash
git clone https://github.com/Liyuk/roundtable-work.git
cd roundtable-work
npm run doctor
node scripts/install.mjs --target /path/to/workspace --dry-run
node scripts/install.mjs --target /path/to/workspace
node scripts/doctor.mjs --target /path/to/workspace
```

| Option | Effect |
| --- | --- |
| `--harness claude` | Installs to `.claude/skills/roundtable-work/` and writes the `rt-developer`, `rt-fixer`, `rt-reviewer`, and `rt-researcher` subagents into `.claude/agents/` |
| `--harness codex` | Installs to `.agents/skills/roundtable-work/` (Codex and other harnesses that read the Agent Skills directory) |
| Default | Installs both |
| `--dry-run` | Only prints the plan |
| `--update` | Upgrade: refreshes skill files and `rt-*` subagents that differ from the new version |

The install script can be run repeatedly. `.roundtable/team.md` and `policy.md` belong to the user and are never overwritten under any circumstances; locally modified skill files are replaced only when `--update` is added. To uninstall: delete the skill directories above, `.claude/agents/rt-*.md`, and `.roundtable/`.

## 2. Configuration (hand it to the agent)

Open the harness in the workspace and have the agent run "Use roundtable-work to configure the team". Following the skill's [setup flow](.agents/skills/roundtable-work/references/setup.md), it will:

1. Check, read-only, the existing configuration and the delegation, messaging, waiting, and wake-up tools that are actually available in the current session (compare with the [harness mapping](.agents/skills/roundtable-work/references/harnesses.md)).
2. Ask only the questions that are missing and affect authorization or acceptance: the workspace and long-term goal, which actions need no confirmation and which need confirmation, roles, budget, and whether to enable external events or timers.
3. Edit `.roundtable/team.md` and `policy.md`; for existing settings, show the diff before changing them. Do not ask for credentials in the conversation, and by default do not automatically merge, deploy, or send messages externally.

## 3. Choosing a deployment form

1. **In-harness setup** (default): the harness provides sessions, delegation, and notifications; Roundtable Work provides roles, rules, and templates; the harness is the sole scheduling authority.
2. **Harness + thin adapter**: when the harness lacks some observable capabilities, fill them in with a minimal adapter, and state the state authority and failure boundaries.
3. **Standalone control layer**: enable only when a real gap has been verified and an implementation exists; it owns its own state, events, authorization, and scheduling, and does not assign work in duplicate with the harness.

Record any missing required capability as a gap: when the next turn cannot be triggered reliably, do not promise that it runs without someone prompting it; when permissions cannot be restricted, do not promise safe full automation.

## 4. Acceptance and handover

First run a low-risk goal in read-only, observation, or sandbox mode:

1. Create a test ticket and confirm the user identity, permissions, version, and owner.
2. Delegate it to an executor and see real receipts for sending, claiming, starting, and completion; the delivery card attaches the actual checks.
3. Have the independent review send it back once and confirm that the original executor receives it and fixes it; while the goal is incomplete, the Chief continues without being prompted, or states the specific wait condition in the continuation record.
4. Advanced (requires harness or adapter support): inject recoverable faults, duplicate events, and process restarts; simulate the user revising the goal, the executor being unavailable, and no progress; verify the authorization threshold for adding or removing roles.

Handover to the user: how it runs, deployment and permissions, where state and records are kept, how to pause and revoke, verification results, unsupported capabilities, next steps, and the actual running cost. For every check, state what was actually executed; if it was not run, mark it as not run.

## What diagnostics can prove

`npm run doctor` only checks the version commands of the candidate CLIs (node, git, claude, codex, pi, dsh); `--target` additionally checks the installed files and version. It does not check login credentials, and it cannot prove that session creation, notifications, background wake-up, or permission control work; those must be actually run through as described in section 4.
