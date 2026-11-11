# A team that grows out of needs: how the studio operates

Status: design and sanitized practice summary, 2026-11-10. The studio case is an actual organizational evolution recounted by the user; the triggers, automatic decisions and setup are proposals of this project and have not yet been validated as a complete system. The user has clarified that the one responsible here for proactive judgment and coordination is **Chief**; session, communication, tool and timing capabilities are provided by the actual host.

## Why a dynamic organization is needed

Users usually give a work goal first, without knowing how many members, which specialties or how complex a process will ultimately be needed. Quality problems, new types of tasks, backlogs and idleness only appear during the work. The studio needs to observe these changes and adjust the organization without repeatedly making a person act as project manager; it also needs to know when not to add people and not to keep doing worthless work.

## The evolution of one studio: a sanitized case

1. **Needs come first**: the user states a development goal, and a developer role is assigned to move it forward first. A small team is enough at this point, and no full organization is assumed in advance.
2. **An acceptance need appears after delivery**: the user wants development and acceptance to be separate, and considers checking with a different model, so a review responsibility is added. What to observe is whether acceptance really finds omissions and whether it reduces rework; a different model does not by itself prove independence or effectiveness.
3. **A fixer role is introduced after problems pile up**: many bugs appear in GitHub issues and need continuous locating and fixing, so a role dedicated to fixing bugs is added; the queues and ways of working for feature development and fault fixing begin to separate.
4. **Development is expanded after feature demand grows**: the feature workload temporarily exceeds existing development capacity, and a second developer is added. When working in parallel, task dependencies, file conflicts and resources need to be judged.
5. **Capacity is reconsidered after demand changes**: after a while, the second developer is not always busy. An idle role is a signal to reassess capacity, and is not automatically equivalent to worthless; first check whether there is suitable, authorized, conflict-free pending work, and then decide whether to keep it on standby, reduce sessions or pause the role.
6. **A research need appears**: after research work recurs, a research position is set up, and the analysis of sourced materials is handed to a dedicated role; research results can enter decisions or new tickets, but do not automatically become development tasks.

This is evolutionary logic abstracted from the user's account; it is not a judgment of design flaws in the original host, nor does it mean this repository has automatically reproduced these decisions.

## How a need becomes work

```text
User gives a goal / later additions
  → The host receives the input, keeping the message, identity, source and actual tool capabilities
  → Wake Chief, and provide the current goal, pending tickets and relevant memory
  → Chief judges the intent, the decidable parts, acceptance, constraints and the next step
  → Choose an existing role or a temporary work session, and issue an assignment card
  → The host delivers and records delivery; the executor claims it and then calls the execution tool
  → The execution result and evidence come back; independent review and rework follow when needed
  → Chief checks against the current goal, and either moves on to the next item or states the waiting condition
  → The user receives a usable result or a question that is truly necessary
```

Chief takes on proactive observation, communication, recall, and task and organizational judgment; the host provides sessions, events, message delivery, processes and tool access. The two can be implemented in the same system, but a piece of work can have only one scheduling authority.

For example: after a developer completes a feature, the host receives the actual process exit or completion event, and hands the result to Chief or, as preconfigured, sends it directly for review; when the reviewer returns `打回` (sent back), the card returns to the original author; after review `通过` (passes), Chief re-examines the original goal and the to-do items, and decides whether to continue with the next one or to wait. If the host cannot automatically wake Chief after it goes idle, the "continue" in the prompt will not take effect by itself, and setup must flag the gap.

## How Chief decides to hire, stand by or shrink

An organizational assessment is triggered by task completion, backlog changes, failures, resource changes or user requests; the deployer can also enable a periodic assessment with a budget. First compare four options: reuse an existing role, start a temporary session for an existing role, establish a new long-term role, adjust the workflow. A role is a long-term capability and identity, and a session is a single run; for short-term peaks prefer a temporary session, and consider a long-term role only when the need recurs and the responsibilities are clear.

A recommended decision should answer at least:

- What kind of work is actually queuing, for how long, can it be parallelized, and is it blocked by a person or an external dependency?
- What are the existing members' real running time, waiting time and available capabilities? A suspended ticket must not be counted as busy.
- What can the new role do, to whom does it report, what tools does it use, what does it accept, and does it need new permissions?
- After it is added, how is usefulness measured; when is it stopped, paused or rolled back?

For example: if bugs keep piling up and there is reproducible evidence, first open a restricted fix session for an existing executor; if it repeatedly competes with feature development for capacity, then create a fixer role within the authorized scope. When the second developer has had no suitable work for several consecutive assessment windows, new sessions can be stopped first while keeping the role and its memory; complete the handoff of tickets and messages before reducing long-term roles. The specific windows and thresholds are configured by the deployer, and an optimal number must not be invented from a single observation.

Simple, reversible adjustments that have been pre-authorized can be executed autonomously; new external identities, expanded permissions or exceeding the budget are decided by the deployer. Record the evidence, plan, decision, impact and rollback. An organizational hierarchy is not mandatory: add intermediate leads only when task volume, domain complexity or information overload truly requires it.

## How multi-layer reporting filters

Executors report results, evidence, risks, unfinished items and requests to their direct lead; the lead handles decidable matters and escalates major risks, cross-group conflicts, and budget and permission issues to Chief. Ordinary progress stays in the ticket to be viewed as needed; failures, unknowns and original grounds are not discarded. Chief aggregates results or specific decisions that are useful to the user. Urgent risks must have a direct escalation path and must not be lost because an intermediate layer is silent.

## Proactivity, time and memory

Being proactive does not mean sending messages frequently; it means that, on receiving a usable signal, one proactively judges **what should be done now**. Signals can come from:

- External events: user messages, issues, review comments, CI, data source updates.
- Internal events: a task ending, a subtask timing out, queue changes, memory being updated, the goal version changing.
- Scheduled events: a daily session enabled by the user, a studio retrospective, a routine content check; with a time zone, interval, budget and deadline conditions.
- Memory triggers: look up similar cases after a failure; find risk conventions before submitting for review; recall past headcount-expansion decisions when the backlog grows; find the previous day's unresolved items when a daily task starts.

Optional **random recall** is used to discover neglected information at low frequency: within a pre-allowed memory scope, draw a small number of candidates and check whether they are relevant to the current goal, whether they are expired, and whether they are worth verifying further; it produces only candidates, and does not directly expand permissions or trigger external writes. Record the sampling reason, source, judgment and budget, to avoid unbounded recollection or repeating work based on old memory. A host that does not support it cannot claim that it will happen automatically.

A daily session should state clearly "the date, time zone, the time the data is current to, the task owner, the goal, leftovers from the previous day and the stop conditions for the day". The make-up policy after absence or restart should be explicit; research and trading information is labeled with data source, time and uncertainty, and trading or fund actions rely on separate authorization.

## The same loop can cover other work

| Scenario | Observation and work sources | Roles and delivery examples | Acceptance and waiting |
| --- | --- | --- | --- |
| Software development | User requirements, issues, CI, review comments | Developer, fixer, reviewer, researcher; changes and evidence | Tests, review, PR; may wait for merge |
| Self-media operation | Topic goals, material, publishing calendar, feedback | Topic selection, research, writing, editing; sourced drafts | Facts, style, copyright/material licensing and human publishing permission |
| Video editing | Material, script, duration, format and revision comments | Material organization, editing, quality inspection; project files and the finished cut | Material accessible, duration/aspect ratio, content quality; publishing permission determined separately |
| Daily research | Specified date, data sources, topics of interest, previous day's leftovers | Data, analysis, review; a traceable daily report | Data freshness and reproducibility; conclusions are not trading authorization |

These are adaptation examples, not ready-made features; each domain needs its own tools, acceptance criteria, authorization and failure policy. Setup first selects a scenario template and then probes the real host's capabilities, and must not impose the GitHub workflow of software development on every team.

## How it actually runs after installation

1. Confirm which session creation, message delivery, completion notification, tool invocation and timing capabilities the host provides; record the unavailable ones.
2. Import the shared understanding and the Chief instructions, and establish one goal and a minimal set of roles; choose that host as the authority for task state and scheduling.
3. Configure the scope that may be decided autonomously within authorization, the role cap, the budget, whether periodic/random recall is enabled, and the message channels.
4. Create one real but low-risk assignment card, execute it, review it and handle feedback; record who sent, received, executed, delivered and woke.
5. When a task has remaining items, verify whether Chief will continue; judge by actual events rather than model promises. If background wake-up is not supported, one can only continue manually or add host capability.
6. Run an observation period, assess adding/pausing roles and adjusting the workflow based on real needs; any automatic configuration change should be traceable and reversible.

This repository currently provides the approach for these operations, an installable skill (prompts and templates) and an in-session walkthrough, but does not yet provide a durable runtime. See the [practice record](../practice/2026-11-10-session-trial.md).
