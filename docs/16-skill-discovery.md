# Discovering and choosing Skills before work starts

Status: prompt flow; whether directory search, web search, installation, and sub-session loading are available is decided by the host.

The steps executed at runtime are inside the skill: [Skill discovery flow](../.agents/skills/roundtable-work/references/skill-discovery.md). This document records the design rationale.

## Why it goes before dispatch

Skills decide whether the executor can use the right method. After splitting the work and before dispatching, the Chief chooses skills for each piece of work and writes them into the assignment card, so that the executor can load them in its own session; waiting for executors to discover them on their own is often too late, or different executors use them differently. When the stage changes (review, fixing, research, and so on), the capability needs change too, so skills are rechecked at stage transitions rather than searched for again every turn.

## Why "only what the recipient actually loads counts as used"

A sub-session does not necessarily share the skill directory or file permissions with the Chief. A skill name written on the assignment card does not mean the recipient can read it; only when the recipient states in the delivery card that it loaded and used the skill can that count as evidence. This is the same principle as "sent ≠ claimed".

## Example

The user wants a bug fixed: the Chief checks the existing troubleshooting, testing, and review skills and writes their paths and purposes into the assignment card; the fixer confirms they are available in its own environment, reads them, and then executes. When no suitable skill exists or it cannot be accessed, it continues with its existing expertise and states the gap.

## What the host adaptation needs to make explicit

The skill discovery directory, whether cross-session reading is possible, how versions are pinned, and the update policy. The install script places this skill in `.claude/skills/` and `.agents/skills/`; the installation of other skills is decided by the user and the host's rules.
