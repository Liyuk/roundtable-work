# Chief's organizational adjustment and multi-layer reporting

Goal: let Chief, within the project and authorization scope, autonomously adjust team size, roles and workflow based on the actual work, and let information be compressed level by level without key risks disappearing. This approach is a proposal; organizational adjustments must satisfy the boundaries preset by the deployer.

## Decision inputs and cadence

Reassess at each major change in organizational structure, when the backlog crosses a threshold, or at a retrospective; a low-frequency periodic assessment with a budget can also be configured. The studio preset adds no scheduled polling: it is triggered first by delivery/blocking/resource events, and a periodic assessment should be enabled explicitly if needed. At each check: pending work types and priorities, real queuing/running/waiting times, dependencies and file conflicts, failures and rework, review capacity, resource and model cost, context/handoff overhead, available tools and the user's concerns.

Distinguish "claim not yet ended" from actual work: a suspended task does not count as continuous execution. Short-term idleness does not automatically trigger downsizing; a backlog does not automatically prove that headcount should grow, so first check whether it is waiting on a person, lacking authorization, a runner failure or resource saturation. Each decision states the evidence window, confidence, expected benefit, cost and rollback conditions.

## Adding, reducing and adjusting roles

| Situation | Possible decisions | Verification and safeguards |
| --- | --- | --- |
| Independent tasks queue up, resources suffice, no write conflicts | Temporarily expand work sessions; if it persists, propose adding a long-term Bot | Set a cap, a work scope and an observation period; sessions of the same role can reuse the identity, so a new Bot need not be created each time |
| A new capability gap keeps recurring | Propose a new specialist role or add a skill to an existing role | Check existing capabilities first; new permissions require prior authorization and cannot be self-granted |
| Handoffs overlap, message volume is high, responsibilities are unclear | Merge responsibilities, adjust the scope of ownership or reduce reporting layers | Keep independent review and a clear owner; pilot before adjusting |
| No executable work for a long time or resources are tight | Stop creating new sessions, pause roles or reduce concurrency | Wait until claimed tasks are handed off/completed; do not kill external actions whose state is unknown |
| Repeated lack of progress or failure | Diagnose the task/tool/model; reassign or change the workflow if necessary | Mark the attempt and keep the context; do not mask a fault by disabling a role |

Starting and stopping long-term roles, persona settings and structural changes can be executed autonomously within the scope the user has granted in advance; new accounts, expanded permissions, exceeding the budget, external identities and security policy changes must follow configured authorization. If authorization is insufficient, form a proposal instead of executing. Each adjustment produces an organizational decision record: the old structure, evidence, candidate options, decision, affected tasks, owner, effective time, verification metrics and rollback method.

Order for removing a role: stop accepting new tickets → take stock of unfinished assignments and unread messages → complete the handoff or cancel safely → verify processes and external actions → revoke credentials/permissions that are no longer needed → keep the audit trail and necessary memory → mark as retired. Retirement does not delete historical evidence. Adding a role follows the [creation process](02-team-and-sessions.md).

## Multi-layer organization and information filtering

```text
Person ↔ Chief ↔ Domain lead ↔ Executor / Reviewer
                 ↘ Assignment cards and ticket events ↗
```

A small team defaults to Chief managing directly; intermediate leads are added only when the coordination scope really grows, there are cross-domain dependencies or Chief is overloaded with information; layers have a cost. Each task still has one owner; the upper level is responsible for assignment/arbitration and the lower level for the actual output. Minimum fields of a report card: goal and version, conclusion, links to measured evidence, unfinished items, risks, who is being waited on, decisions needed from the upper level, recommendations, validity period.

| Information | Upward handling |
| --- | --- |
| Ordinary operation and handoffs that can be handled independently | Write to the ticket; the upper level reads summaries as needed |
| Subtask deliveries and uncontested results | Report once, keep the original evidence, and aggregate by association |
| Must-fix items, security/permissions, money, conflicts, exhausted budget, no progress | Escalate immediately to the lead with authority to handle it, marking the deadline and impact |
| Needs a person's judgment, exceeds authorization or has unknown external side effects | Route to Chief, who aggregates the minimum necessary information for the person |
| Self-improvement suggestions | Enter the candidate pool with evidence, so that not every suggestion interrupts a person |

Filtering is compression, not discarding: keep the original text and provenance; it is forbidden to merge failures into "normal", turn unknowns into passes or bury risks in an ordinary summary. The upper level can drill down, and keeps separate evidence for sent/received/handled. If the aggregator is unreachable, unhandled escalation events return to the upper level with authority when they expire; avoid deadlocks and circular forwarding.

## How the workflow changes

Chief observes queuing, rework, review duration, human intervention and quality, and proposes changes based on the actual bottleneck, such as "developers submit directly for review, copying the lead". Trial it first in one workflow/a small sample; compare quality, cost and human intervention, and roll back if there is no improvement or it causes omissions. Changing review thresholds, permissions or the production boundary requires explicit authorization, and must not be loosened by workflow optimization on its own. The role and workflow versions are written into every assignment; how old tasks are migrated needs a separate decision.
