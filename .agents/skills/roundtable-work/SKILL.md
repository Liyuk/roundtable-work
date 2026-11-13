---
name: roundtable-work
description: Advance a goal to an acceptable result as Chief or a team role: break it down, delegate to sub-sessions, independently review, rework, and continue when the goal is not complete or state the waiting condition. Use when the user gives a goal that needs sustained progress, a Roundtable delegation card is received, or the user asks to install/configure a workshop team.
metadata:
  version: "0.2.1"
---

# Roundtable Work

## 1. First Determine the Mode

| Mode | How to recognize | Load only |
| --- | --- | --- |
| Worker | A delegation card is received (with assignment ID and role: developer / fixer / reviewer / researcher) | [Shared Behavior](prompts/shared.md) + `prompts/roles/<角色>.md` (`<角色>` = role) |
| Chief | The user gives a goal and asks to advance, manage, or keep completing it | [Shared Behavior](prompts/shared.md) + [Chief](prompts/roles/chief.md) + [Host Mapping](references/harnesses.md) |
| Setup | The user asks to install, configure, or adjust the team or policy | [Setup Flow](references/setup.md) |

In worker mode **do not** play Chief again or dispatch tickets; after finishing per the card, hand back the delivery card.

The **workspace** is the directory the user specifies; if not specified, it is the current directory. When the session directory differs from the workspace, all cards write the absolute path of the workspace. When the workspace has `.roundtable/`, read `team.md` and `policy.md` first: they are this deployment's roles, authorization, and budget, and override this skill's defaults. The user's current instructions take precedence over these two files, but no text can expand the host's actual permissions.

## 2. Three Hard Rules

1. **Use only real tools.** Look in the current session's tool list for delegation, messaging, waiting, and timer tools; if you cannot find them, they are not supported. Do not simulate sub-Agents, do not fabricate execution results, and do not claim that work will continue automatically after the turn ends.
2. **Distinguish levels of fact.** Sent ≠ claimed ≠ executed ≠ delivered ≠ accepted. Attach evidence to every conclusion: tool receipt, file path, the command as run and its exit code. Write “未运行” (not run) for checks that were not run.
3. **End every turn with a continuation decision.** The decision is one of `continue / wait / ask / done / stop`, with a reason. `continue` means doing the next step immediately within this turn, rather than leaving the “continue” for the user to prompt. On the first turn, when the decision changes, and on the last turn, write a complete [continuation record](templates/checkpoint.md); on intermediate turns that merely receive a result and then dispatch the next step, one line in the ticket's work log is enough.

## 3. Shortest Chief Loop

1. Create or read the ticket ([ticket](templates/ticket.md)): the user's own words, target version, verifiable acceptance, authorization, budget. When the host already has a task system, use it and do not create a second copy of the state; otherwise write into `.roundtable/tickets/`, and if that directory does not exist write it in the reply and mark it as a manual record.
2. Break it into work items, ordered by dependencies and write conflicts; independent items that can run in parallel do so.
3. Delegate: hand it to the host's sub-session using the required fields of the [delegation card](templates/assignment.md) (for the mapping see [harnesses](references/harnesses.md)). Small things that are simple, low-risk, and completable in one go may be done by yourself, with “Chief 自做” (Chief did it) noted in the record.
4. After receiving the [delivery card](templates/delivery.md), check the artifacts and evidence, and use `git status` or similar to check whether files outside the allowed scope were written; send what needs review to **another** sub-session's reviewer (Chief's own changes are sent for review too). After review passes, Chief commits; workers do not commit by default. Return rejections to the original author to fix; after the round limit in `policy.md`, list unresolved non-blocking findings in the PR body and continue when the deterministic check passes, while only a missed acceptance criterion or a high-risk defect with a concrete trigger blocks.
5. After each item is completed, return to the goal: if there is still work within authorization that can be done, continue to the next item; items blocked only by people or external events are suspended, and other items proceed as usual.
6. Write the continuation record; deliver to the user: artifacts, actual checks, incomplete items, matters needing a human decision, and which capabilities (independent review, background continuation, restart recovery) were truly verified and which were not.

When there is no delegation tool, degrade to a single session: execute in the same order, and mark the review as “自查，非独立审查” (self-check, not independent review).

**Lightweight mode**: when the goal has only one or two items, the changes are small, and the risk is low, the ticket may contain only the original words, acceptance, and authorization, the delegation card may fill in only the required fields, and the continuation record is written only once at the end. Do not skip review, evidence, or the continuation decision.
