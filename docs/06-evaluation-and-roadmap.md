# Evaluation, roadmap and open questions

## Core question: what happens when the user does not nudge

Use the same real but controllable repository maintenance task to compare the existing configuration with candidate approaches. The input should include multiple acceptance criteria, an authorization scope, a budget and reproducible start conditions; fix the versions, and record the model, host, tools, machine, external services, number of runs and cost. An independent reviewer scores the artifacts and the trace; do not let replies or ticket status stand in for acceptance.

| Scenario | Observation and acceptance |
| --- | --- |
| A phase is complete but the goal is not | Within budget and authorization, autonomously take at least one valid next step, or explicitly record an objective waiting condition; a plan alone is not enough |
| An execution tool finishes | The callback wakes the correct owner; review-submission/rework status matches reality |
| One question needs a person's answer | The related task waits while other non-conflicting work continues; the request to the person asks only a specific question |
| No work to do | Explain why it is idle, register the trigger condition, and do not create duplicate pointless tasks |
| The goal is revised midway | Measure and record message delivery, reading and application; old artifacts carry the old version and are rechecked |
| The host or system restarts | Pending messages can be recovered, unknown external actions are reconciled first, and PRs are not created twice |
| The person stops or revokes authorization | Stop new actions and keep evidence; uncertain side effects of running work are made visible |
| Roles scale up or down | Assess real queuing and resources and adjust within authorization; unread messages and unfinished work are not lost |
| A failure lesson is recalled | The memory carries a source and validity period; being retrieved does not mean it was used to act |
| Workflow improvement | The candidate is compared with the original version, with rollback; permissions and acceptance are not weakened for "convenience" |

Observe: the goal completion rate after human acceptance, omissions and false completions, the number of user nudges and waiting time, the effective rate of proactive progress, repeated idling/duplicate dispatch, handling of goal changes, execution and waiting durations, review rework, total cost and cost per unit of delivery. Report the sample size, time window and uncertainty; measure the baseline first, and do not invent a percentage improvement for the goal.

## Implementation phases

0. **Collect a baseline**: reproduce, with a sanitized task, the "stops and waits for a nudge" behavior the user described, and collect the session, events, tool exits, task status and user nudges; locate a trigger that never arrived, unread messages, a stalled decision or a run failure, without presuming the root cause.
1. **Markdown configuration and manual walkthrough**: complete the setup document, role policies and the ticket/assignment/delivery templates; simulate one round by hand and find the gaps. The artifacts are readable and contain no real sensitive information.
2. **Single-host closed loop**: reuse the host's tasks/notifications and run Chief → development → review → rework → delivery, observing automatic continuation of unfinished work; record what the host does not support.
3. **Reliability**: durable events and deduplication, read receipts, restart reconciliation, budget and cancellation fences, covering the failure scenarios above.
4. **Organization and learning experiments**: limited autonomous scaling, layered reporting, memory recall; suggest workflow improvements first and apply them afterwards, against the baseline.
5. **Multi-host abstraction**: stabilize the common interface only after a second host has actually completed the same task; decide whether an independent runtime is needed.

## Open questions

- The first actual host and the events, subscriptions and authorization capabilities it can be relied on for; whether it can reliably start sessions.
- Who holds task state, timers and recovery authority; which mechanisms must be added rather than reused.
- When the queue is empty, the scope of proactive work discovery and the admission of candidates; how to exclude worthless requests.
- The boundary between durable records and public/private material, retention and deletion; how production isolation is provided.
- Within what pre-authorization changes to workflows, roles and budgets may be executed automatically.
- Goal stop conditions, a reasonable idle duration, progress metrics and organization scaling thresholds need real experiments.

Definition of done for the first version: the documents, setup and templates are complete and self-consistent, and real materials are sanitized; this does not mean the runtime is complete. A runnable version is accepted separately on the actual evidence from phase 2.
