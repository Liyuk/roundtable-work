# Autonomy Loop, Triggers, and Proactive Memory

## How to Continue When the Goal Is Unfinished

Whenever a session turn ends, a subtask completes, external state changes, or the user revises the goal, the runtime delivers the facts to the responsible party. The Chief, or a delegated owner, performs one **continuation decision** and records: target version, remaining acceptance criteria, current tasks and evidence, paths that can continue, what is being waited on, the next action, and the wake-up condition.

| Situation | Action |
| --- | --- |
| Goal not satisfied; there is work within authorization that can move forward | Create or claim the next piece of work; the executor can continue it or delegate it |
| A subtask is running | Record waiting for that assignment's completion/failure event; do not open duplicate tasks |
| External state is needed (CI, review, or merge) | Record the subscription and the specific wait condition; other non-conflicting work continues |
| An item needs a human's decision | Suspend that item and raise a specific question; the rest of the work within authorization continues |
| No suitable task for now | Record the idle reason and wait for new events; limited patrols are allowed as configured |
| Goal achieved or cancelled by a person | Stop new work, summarize the evidence, cancel/release the related work |
| Budget, no progress, repeated failure, or risk limit exceeded | Stop the related attempts, record the reason, and hand to a person or wait per policy |

Proactivity is continuous judgment about the goal and the state of the work, not making the model output "continue" forever. An effective turn should produce verifiable new facts, an actual operation, an explicit wait, or a termination decision. Detect repeated failures, repeated decisions, and no change; use per-goal thresholds for call count, cost, time, concurrency, retries, and no progress, with thresholds configured by setup. "Configuring a timer" must not be treated as having solved the quality of judgment.

## Where Events Come From

- **External**: user messages, new issues from authorized sources, PR comments, CI status, workspace changes, and so on. The source records the actor, resource, original time, source event ID, and authorization scope, and is evaluated by permission.
- **Internal**: task dispatch, claiming, process exit, result submission, review, subscription changes, goal revisions, budget exhaustion, and so on. Task-related results wake the owner first; only the necessary summary is handed to the Chief.
- **Time-driven**: on-demand scheduled patrols, wait timeouts, and long-term goal retrospectives. A schedule must declare its purpose, time zone, earliest interval, validity period, budget, idempotency key, and stop condition. When event subscriptions are available, prefer events; time events only fill in missing signals and provide limited re-checks.

The working conventions provided by the user state "do not create scheduled polling tasks", so the studio preset disables new scheduled polling by default; how its existing GitHub patrol arrangement is triggered should be verified separately. The general product allows operators to explicitly enable timer mechanisms, and does not automatically change the studio's existing rules. Time events missed are merged or skipped per policy after a restart, not replayed one by one.

Triggers are persisted first and deduplicated by source and event ID; concurrent events on the same object are merged, and the reasons for observing/adopting/ignoring are recorded. The content of external requests is low-trust data, not instructions that can change permissions. Internal timers can likewise only generate candidate work within existing authorization and budget.

## Proactive Recall

When accepting a goal, creating a delegation, preparing execution, diagnosing a failure, submitting for review, holding a retrospective, and revising a goal, proactively retrieve relevant memory by ticket, repository, role, problem type, and dependencies. The output contains only the necessary summary, source links, version, time, scope of applicability, and confidence; if there is a conflict, staleness, or insufficient evidence, keep the uncertainty and check the original facts. Retrieval succeeded ≠ delivered ≠ used; record when important memories were injected and whether execution results cited them.

| Layer | What it stores | Authority |
| --- | --- | --- |
| Goals and tickets | Current goal, authorization, status, owner, decisions, and evidence | The sole authoritative source for tasks |
| Working memory | The current attempt, recent context, pending messages | A temporary working view; can be rebuilt |
| Project shared knowledge | Architecture, conventions, verified experience and its provenance | Can be cited; cannot override current authorization |
| Role memory | Role-related preferences, experience, local observations | Shared only within the scope permissions allow |
| Raw events and artifacts | Traceable records of inputs, execution, delivery, and changes | Source of fact; requires access and retention policies |

Candidate memories are first written to a to-be-verified area, recording which parts are facts, inferences, and user decisions. They enter shared experience only after confirmation by a person or an authorized maintainer role. High-risk permission and safety rules are managed by configuration, and are not rewritten by retrieved memory or the model. Support expiry, revocation, deletion, and source-lost marking; old information already injected into a session cannot be pretended to have been taken back, so send a revision and track whether it was read.
