# Chief, Bot, and Session

## Separation of Concepts

| Concept | Meaning | Lifecycle |
| --- | --- | --- |
| Chief | The coordinating role responsible for the user's goal and overall delivery | Usually long-lived; the session can be replaced |
| Bot / role | A stable identity, responsibilities, model tier, skills, tool permissions, and communication boundaries | Long-lived across tasks |
| Session | A running instance that carries a given conversation and its context; one role can have several | Can be created, compacted, resumed, and ended |
| Ticket | A trackable goal or work item, with one final owner | Spans multiple rounds and multiple sessions |
| Assignment | One explicit delegation to a given executor under a ticket | Can have multiple attempts |
| Attempt | A single process or model invocation | Failures/retries do not overwrite history |

Names, personas, and models do not constitute task ownership or authorization. The task owner belongs to the ticket, and the reviewer can differ from the owner. Creating a team member need not mean a model process permanently occupies resources.

## What the Chief Does

1. Maintain the user's original goal, current version, scope, authorization, acceptance criteria, and pending decisions; when the goal changes, notify the affected tasks and re-check old artifacts.
2. Receive the user, external events, team results, and necessary time events; distinguish new work, follow-ups to existing tickets, context only, ignorable items, and items awaiting a human's judgment.
3. Maintain a cross-ticket global view: order dependencies, deduplicate, judge priorities and resource conflicts, choose roles, and issue structured delegations.
4. Track claiming, execution, delivery, review, and blockers; based on the facts, decide whether to continue, switch paths, rework, wait, or finish; avoid treating drafts as complete.
5. Notify people only when results are usable, a decision is needed, authority is exceeded, or work is genuinely blocked; each question comes with the options already tried, the impact, and the decisions to choose from.
6. Hold retrospectives periodically or when triggered by events, and propose verifiable improvement candidates.

The Chief may read tool summaries and necessary evidence; time-consuming research, coding, and full reviews should be handed to executors. Exceptions are configured per deployment; this responsibility restriction is not to be treated as a system safety boundary.

## Creating a Bot

The deployer chooses a template, or the Chief proposes a new role under prior authorization. A creation card includes at least: a stable bot_id, responsibilities and prohibitions, who it reports to, the ticket types it can take, available skills, runner and model tier, workspace, resource limits, communication scope, authorization ceiling, and retirement rules. First check whether a reusable role exists, to avoid creating a new Bot endlessly for every task. How many long-lived roles are created and whether they are created automatically is set by the deployer; creating a role must not expand any authorization.

Procedure: validate the role and permissions → save a versioned profile → the host creates/binds a session (if supported) → inject the stable identity and shared discipline → run a capability self-check → write a created event. On failure, keep the failure reason and do not claim it was created. For new accounts, external identities, or broader permissions, handle them according to the actual authorization.

Session initialization loads: identity and stable rules, the current ticket and authorization snapshot, relevant memory summaries, descriptions of available tools, and the budget. Task information is not solidified into a long-term persona. When rotating/compacting, write a structured handoff that records unfinished items and unread messages; the new session must restore the actual identity, ticket, authorization, target version, and available tools. Inject only the context that is currently needed; do not stuff all history into the prompt.

## Candidate Responsibility Mapping for the Studio

| Role | Responsibility | Prohibited by default |
| --- | --- | --- |
| Chief | Liaison with the person, splitting work, dispatching, gatekeeping, reporting | Doing large stretches of coding in place of executors |
| Developer | Features and filling test gaps | Overwriting each other's files in the same batch; merging directly to main |
| Fixer | Locating and fixing bugs | Taking ordinary features; taking over a PR whose author is still fixing it |
| Reviewer | Reviewing, executing acceptance, giving verdicts | Treating self-reports as execution evidence |
| Researcher | Research and sourced reports | Turning into development or external publishing without authorization |

These are example roles; whether a deployment uses these names and models is configured by the operator. For the role implementation, see the [studio preset](../profiles/studio/README.md).
