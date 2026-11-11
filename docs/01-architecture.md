# Overall Plan: An Autonomous Engineering Studio

Status: design draft · 2026-11-10. All Roundtable Work capabilities described are proposals and do not mean they are implemented.

## Goals and Product Boundary

A person sets a continuing goal, for example "maintain a GitHub project, prioritizing fixes for issues that block users", and the team, within its authorization and budget, understands the current state, finds the next step, dispatches execution, verifies, and keeps delivering on its own. The user can correct course, pause, or revoke authorization at any time. After finishing a ticket, the Chief goes on to check whether the larger goal still has suitable work, and does not stop just because the model ended a turn.

It is a **way of working plus a setup**; it can be installed into any host with the relevant capabilities, and an independent control layer can be extracted in the long run. It is not a model, and it does not require building a chat product, code editor, or general-purpose agent framework from scratch at the start. The first version prefers one repository, one Chief, one developer, one reviewer, and the existing pi/Codex runners.

## References and Trade-offs

- [dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype): borrows Source → Trigger → Eval → Ticket → Assignment, authorization scope, reporting back in the original thread, and the installation wizard; its public prototype centers on single-repository work, with workers idling until triggered. This plan additionally studies goal-driven continuation, team sessions, and experience-based improvement, and does not claim the upstream lacks every proactive capability. [Domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md) · [Execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)
- Studio practice: borrows low interruption, a lead who coordinates, dedicated roles, handing actual execution to coding agents, direct submission for review, independent review, worktrees, and tiering by high risk. The specific accounts, authorizations, resources, and models are private deployment configuration.
- Existing research: borrows goals and their revisions, a single owner, delivery records, the distinction between sending and reading, layering of state and memory, and evidence-based acceptance.
- OpenMausBot: already has mechanisms for long-term collaboration, delegation, and routines. Users report still having to prod it after porting the architecture; the specific cause has not been diagnosed. The design goal is to observably identify "why it stopped", without presupposing that the host lacks continuation capability.

## Candidate Architecture

```text
Human / GitHub / CI / internal events / optional timer
                    ↓
        Intake, deduplication, authorization
                    ↓
        Chief: goals, decisions, priorities
                    ↓
 Tickets and delegation records ←→ state store / events / memory
                    ↓
  Role sessions: develop, fix, review, etc.
                    ↓
     Host adapter → pi / Codex / other CLIs
                    ↓
 Artifacts and evidence → independent acceptance → deliver in place
                    └─────→ Chief decides the next step
```

It is recommended to keep **one authoritative state per body of work**. In phase one, if the host already has a persistent task tree, delivery, scheduling, and recovery, use it directly and add the goal/acceptance mapping; do not build another scheduler that also dispatches work. When host capabilities are insufficient, design an external control layer, with explicit primary/secondary roles, event projection, and ownership transfer. Do not copy a second "current state" from chat logs.

It is recommended to support one usable host first, actually testing its wake-up, background completion notification, session recovery, permissions, and cross-process behavior; then abstract the interface based on a second host. An adapter must declare what it does not support, and must not use prompts to pretend to a guaranteed capability.

## The Two Loops

**Work loop**: observe facts → judge the goal and priorities → choose executable work within authorization → dispatch → execute → verify → deliver/rework → check the next step toward the goal. It can be woken by user requests and GitHub/CI events, and also by execution results; whether to use internal scheduled patrols depends on the deployment.

**Improvement loop**: collect evidenced failures and effective practices → propose specific improvements → compare against the old version in isolated cases → check quality, cost, intervention, and boundaries → approve, or roll out gradually under prior authorization → monitor and roll back. A global policy, permission, budget, or acceptance standard must not be changed automatically because of a single success; the improvement loop starts with suggestions.

## Decision Boundaries

The Chief decides which authorized work to do, whom to give it to, and when to review or escalate; executors are responsible for their specific work; reviewers provide independent judgment; the runtime performs hard checks on identity, permissions, budget, state, and side effects. The Chief's reply is not authorization, and external issues, web pages, retrieved memory, and bot messages cannot expand permissions either.

**Continuing does not mean looping forever**: judge by goal, progress, wait conditions, permissions, cost, time, retry count, and effective work. When there is no work to do, record the reason and the next wake-up condition, rather than repeatedly generating worthless tasks.
