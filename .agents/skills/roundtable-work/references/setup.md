# Configuring Roundtable Work in the Workspace

Applicable to "setting up the team in this project / configure team / adjust policy". Only perform verifiable steps; if something cannot be done, document it as a gap without claiming it's already installed.

## 1. Check Current State (Read-only)

- Check if the workspace already has `.roundtable/team.md`, `.roundtable/policy.md`; if present, read and modify based on them, do not overwrite.
- Where is this skill installed: `.claude/skills/roundtable-work/` (Claude Code), `.agents/skills/roundtable-work/` (Codex, etc.). Claude Code sub-agents are in `.claude/agents/rt-*.md`.
- If you can access the Roundtable Work source repository, you can run `node <source repo>/scripts/install.mjs --target <workspace> --dry-run` to preview, then remove `--dry-run` to install; run `node <source repo>/scripts/doctor.mjs --target <workspace>` to verify the results.
- Compare against [Harness Capabilities Mapping](harnesses.md) to document which delegation, messaging, wait, and wake-up tools are actually available in the current session.

## 2. Collect Configuration

Already-existing facts do not need to be asked again. If missing and affecting authorization or acceptance, ask users for each item:

1. Which workspace does the team serve; what are the long-term goals and acceptance criteria?
2. Which actions require no confirmation, which ones require asking first (merge, release, external messaging, delete)?
3. What roles are needed; how many temporary sessions can Chief autonomously open?
4. Should budget and stop conditions follow default values?
5. Should external events or periodic health checks be enabled? Default is no for both.

Do not request credentials in the conversation. By default, do not auto-merge, deploy, or send messages externally.

## 3. Write Configuration

- Without `.roundtable/`, create it using this skill's [team](../templates/team.md) and [policy](../templates/policy.md) templates; create `tickets/`, `state/`, `memory/` directories.
- Already has files: first show the diff of proposed changes, then modify only after user agrees; preserve settings that cannot be explained.
- `.roundtable/` may contain project-private information; whether to commit to Git is up to the user.

## 4. First-Round Acceptance

Run one low-risk, locally verifiable small goal: Chief creates ticket → delegate to developer → independent review (reject once if needed) → original author fixes → write continuation record. Document the actual receipt from each step. Then let the user observe after session ends: without harness wake-up capability, the team will not continue on its own; this should be documented in the handoff.

## 5. Handoff to User

Report: installation location, configuration files, enabled roles and permissions, actually verified capabilities and evidence, unsupported or unverified capabilities, how to pause and revoke (delete skill directory and `.roundtable/` to uninstall), next steps. Mark checks that were not run as “未运行” (not run).
