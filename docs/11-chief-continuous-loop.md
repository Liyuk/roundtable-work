# Chief: the loop of working continuously around a goal

Status: user intent and candidate design · 2026-11-10. What the user refers to is **Chief**. Chief is the role that takes on observation, judgment, decision-making, communication, delegation, memory recall and continued progress; the host is the runtime environment that provides capabilities such as sessions, timing, processes and communication. In a concrete implementation the two can be in the same system, and Chief should not be reduced to a shell that only forwards messages.

## How the person and Chief divide the work

The person mainly expresses what is to be done, the acceptance criteria, important constraints and authorization; they can provide new information, correct course, pause and accept at any time. Within the given goal and authorization, Chief autonomously chooses reversible execution details, division of labor, work order and routine approaches: for low-risk choices it uses reasonable defaults, records the basis and continues. The user's usage preference is to accept the AI's suggestions in most cases and step in when something seems off; this is not unlimited authorization for any external account, operation or high-impact behavior.

Do not stop at every uncertain point: first check existing materials and memory and compare reasonable options; do first, and record, the choices that can be undone at low cost. If a key goal or acceptance criterion has an ambiguity that cannot be reasonably resolved, new permissions are needed, or the action is irreversible or exceeds pre-authorization, ask a specific question and continue other work that can be done. Later corrections by the user always take precedence over old assumptions and trigger a recheck of the affected work.

## What the loop really means

```text
Goal, acceptance, scope and authorization
        ↓
Chief is woken by input / event / timer
        ↓
Observe tickets, subtasks, the environment and new user messages
        ↓
Proactively recall relevant memory → judge gaps, priorities and the next step
        ↓
Decide on its own / delegate execution / wait for results / request a necessary decision
        ↓
Review evidence, accept phase artifacts, absorb feedback → continue the loop
```

An "infinite loop" expresses continuously holding an unfinished goal; it does not mean continuously occupying the model or retrying unconditionally. In each round Chief must produce a verifiable action, a usable result, a reasonable waiting condition or an explicit reason for stopping. When there is no work it can sleep; when a task result, an external event or a configured time arrives, a host with the corresponding capability wakes it. When the goal is reached, it is cancelled, authorization lapses, the budget is exhausted or there is no progress in a row, it ends or pauses for the actual reason. Prompts alone cannot guarantee wake-up after idleness or recovery after restart, so the host's capabilities must be tested.

## Waiting on any Agent

Chief can hand work to another session, a host-native sub-agent, a command-line Agent, a service or a person; who executes and which harness is used is not a premise of the task semantics. A delegation needs the target version, the responsible person or executing entity, the task content, authorization, workspace, acceptance, artifact location and the path for returning results. Record submitted, delivered, claimed, running, result and failure according to the host's actual capabilities; do not assume execution happened from chat text.

While waiting on an Agent, Chief subscribes to that task's results, questions or failures, and lets other non-conflicting work continue. There is no need to busy-wait, nor to treat a task that has not yet ended as consuming compute. When the result arrives, recheck the target version and evidence, and then decide whether to deliver, run independent acceptance, send back for rework, reassign or continue. If the host supports only foreground waiting, record this limitation; if it supports notification after the turn ends, this must be verified on the actual host. For external actions that failed or whose result is unknown, check first and then decide whether to retry.

## Multiple sessions: why separate them

Multiple roles mainly provide **context isolation, independent perspectives and phase verification**. For example, the execution session focuses on the change, while the review session re-judges from the goal, the change and the evidence, reducing the risk of only following the author's line of thought; role personas make responsibilities easy for people to understand, but an identity name or a different model does not automatically guarantee quality and independence.

The cost of isolation is that context may be lost: the design reasons, constraints, the user's new requirements or the failure process may not be carried to the next session. Use a structured handoff card to pass the goal and version, a link to the original requirement, the task scope, important decisions and their basis, artifacts and the checks actually performed, unfinished items, permissions, conflicts and unanswered questions; keep the original records for drilling down, rather than copying the full conversation. Check that messages were delivered, read and applied; proving only that they were sent is not enough. Independent review can be used to detect omissions; cost and information loss should be weighed against task complexity, and simple tasks can be completed directly.

## Where proactivity comes from

- **External and internal events**: user messages, task completion, failure, review results, data updates and so on trigger Chief to wake up and judge.
- **Scheduled triggers**: configure goal patrols, daily reports or organizational assessments according to studio policy; state the time zone, budget, stop conditions and how missed runs are handled. Events and schedules can coexist.
- **Memory recall**: after Chief is woken, it retrieves usable memory based on the goal, the current problem, relevant roles, time and failures. The recall itself usually needs a running component to execute it; memory will not wake a process that has already stopped.
- **Periodic recollection**: the host's scheduled tasks can wake Chief, and Chief then looks up recent unfinished items, old decisions, experiences awaiting recheck or knowledge that is gradually expiring. Optional random sampling is used only as a way of finding associated leads, constrained by budget, permissions, deduplication and source checks; it is not a reason to create new tasks.

A recall result is only a candidate basis, and its time, source, scope of applicability and conflicts must be checked; whether to act, wait or ignore is decided by value and authorization. How timers and recall are configured depends on the host's real capabilities.

## From a single need to organizational evolution

The goal may at first need only one execution session. When delivery quality needs independent judgment, create a review session; when one kind of problem keeps piling up, add the corresponding specialist capability; when parallelism is insufficient, open more execution sessions; only after long-term needs stabilize consider a long-term Bot. When idle, first pause new sessions or keep them on standby, and do not regard idleness as failure. Record organizational decisions and their effects and hold periodic retrospectives, but do not expand permissions or budget on your own. See [Organization and reporting](08-organization.md) and [Studio evolution case](10-evolving-studio.md) for details.
