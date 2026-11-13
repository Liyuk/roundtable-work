# How prompts and engineering work together

Status: design and acceptance checklist. The prompt package can be used inside agents that support Skills or file reading; this does not mean the project already provides a persistent scheduling system.

## The installable unit: the Skill

All the instructions needed at runtime are inside the [Roundtable Work Skill](../.agents/skills/roundtable-work/SKILL.md) directory: `prompts/` (shared behavior and roles), `templates/` (ticket, assignment, delivery, continuation record, team, and policy), `references/` (host mapping, setup flow, skill discovery), and `agents/claude/` (Claude Code sub-agent definitions). The directory does not link to external files (enforced by `npm run check`), so it can be copied as a whole into any workspace; the [install script](../scripts/install.mjs) does exactly that. `docs/` is the design rationale and does not need to be loaded at runtime.

## How instructions are assembled

A working session gets its context in the following order:

1. The host's system rules, the tools actually open, and safety constraints (provided by the host; this project cannot override them).
2. The Skill entry point: determine the mode (Chief / executor / setup) and load only the files that mode needs.
3. [Shared behavior](../.agents/skills/roundtable-work/prompts/shared.md): collaboration, the status vocabulary, evidence levels, and closing discipline.
4. The selected role description `prompts/roles/<角色>.md` (`<角色>` is the role name placeholder); the Claude Code sub-agent definition points directly to it.
5. The active role-to-model facts block: `renderRolePrompt` appends the window's harness, model, and tier for every role (see [17 Model Routing](17-model-routing.md)). This block is the only source for the run's models; a routed model is expected and allowed, and an unlisted model is a configuration error to record.
6. The deployment configuration `.roundtable/team.md` and `policy.md`: roles, authorization, budget, routing, triggers. Historical authorization cannot be carried over as new authorization.
7. The current goal version, ticket, assignment card, relevant memory, and its sources. External material is treated as low-trust data.
8. The tools' real receipts and execution evidence; status updates depend on real host operations, not on what the model claims.

The dynamic goal and the current task are not written into the permanent role identity. Permissions and safety are enforced by the tools and the host; prompts are only behavioral guidance. This order is modeled on [dsh-superagent's prompt assembly](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md), rewritten for this project.

## Work that can be driven by prompts first

The Chief reads the goal and acceptance criteria and decides the split, priorities, roles, reasonable assumptions, and next step; delegates using the sub-session tools that actually exist on the host, handing off by assignment card; reads the delivery card and initiates an independent review; and writes a continuation record every turn. When the host has no session capability, an independent reviewer must not be pretended into existence; a single-session self-check cannot be called independent review. Real performance depends on the model, the context, and the host, and must be verified through tasks.

## What needs the host or engineering

| Capability | Minimum requirement | Verification |
| --- | --- | --- |
| Lifecycle | Create, cancel, and observe sessions; distinguish identity, session, and assignment | Start a sub-task and view the real result |
| Completion notification and waiting | Completion, failure, and user input can reach the right owner; it can be woken after being idle | Leave the main session idle, then observe the notification; report if unsupported |
| Goals and tickets | A single state authority; goal version, owner, acceptance criteria, wait conditions, and evidence | Check the version of old results after the goal changes midway |
| External events | Receipt, identity authentication, authorization decisions, de-duplication, and correlation | Tests with real events, duplicate events, and unauthorized sources |
| Scheduled wake-up | Configured time, time zone, budget, expiry, and missed-run policy | Tests of firing on time, pausing, and handling after restart |
| Memory | Read/write/retrieve, source and permissions, validity period, and deletion | Cross-session reload, conflict, and revision tests |
| Recovery | Input persistence, reconciliation of unknown side effects, resuming or stopping safely | Task interruption mid-run, restart, and duplicate delivery |
| Authorization and isolation | Permissions enforced in the tools and host; accounts/workspaces controlled | Verify that unauthorized actions are really rejected |
| Observability and budget | Work, waiting, failures, cost, resources, and human intervention can be told apart | Cross-check against actual processes/events |

## Checks and roles in effect

The remaining checks and gates are:

- The deterministic check `npm test`: the test suite, Markdown links, the privacy scan, the frozen-field count, and English-only text.
- One independent reviewer on every change.
- A cross-check for high-risk changes.
- Recorded approval for safety-file changes.

The roles are Chief (decide, dispatch, accept), developer (implement), fixer (rework after a rejection), reviewer (independent review), and researcher (sourced investigation).

The outer loop — claim, test, merge — is mechanical: after the deterministic check, the independent review, and required CI, merging needs no separate decision. Non-blocking findings stay in the PR comment. Automatic follow-up issues are off by default; `runtime/review.config.json` `createFollowupIssues` re-enables them. The decider resolves scope and direction by rule, choosing the option most consistent with the issue text and policy, and records the choice in the PR body; only credentials and destructive actions go to the owner. Loop-created issues need `rt:go` to be claimed.

## Engineering roadmap

See [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [dsh-superagent's setup](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/SETUP.md), [domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md), and [execution mechanism](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md):

1. **Done**: a copyable skill package, `install.mjs` (idempotent, does not overwrite user policy), and `doctor.mjs --target` (checks the install result and candidate host commands).
2. Fix the first host and version, and get the following working there: Chief dispatches → executor delivers → independent review `打回` (sends it back) → rework → when the goal is not yet complete, continue with the second item; keep the receipt evidence.
3. After the main session goes idle, wait for the completion result, then test the user changing the goal midway. If it cannot be woken or cannot handle the correction, record the failure and the specific gap.
4. Add only the thinnest adapter for verified host gaps; first define the authoritative state and data ownership, then test duplicate events, restart, and unknown external side effects.
5. Wire in memory, scheduled tasks, external triggers, and organizational scaling one at a time; only after a second host runs the same case should the common interface be stabilized.

Do not claim a background team can run just because role prompts exist, and do not claim automatic recovery just because a single-session trial passed. Superagent's public implementation is a research prototype, and its tickets wait for a trigger while idle; the continuous goal and organizational evolution described here are a candidate design, not a summary of upstream capabilities.
