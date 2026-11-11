# Single harness first: dispatch, collection, and communication

Status: design recommendation compared against public material, 2026-11-10; an install script that puts the skill into Claude Code / Codex workspaces exists, but no background service is implemented. For a comparison table of host tools see [host mapping](../.agents/skills/roundtable-work/references/harnesses.md). The goal is to first run the Chief and sub-tasks inside one real host such as Codex or Claude Code; cross-harness is a later optional capability.

## Core choice

```text
User ↔ Chief (main session)
          ├── host-native delegation → executor session → host collects result ─┐
          ├── host-native delegation → reviewer session → host collects result ─┤
          └── ticket / memory (recorded per actual host capability)             │
             ↑ user additions, completion events, configured timed reminders ←──┘
```

When the same host can handle dispatching, sending messages, waiting, and collecting results, use its native tools. Roundtable Work provides the Chief, roles, assignment cards, continuation, and acceptance discipline; it does not introduce gRPC, a message server, or a second scheduler. Sub-sessions are created only when a task needs multiple roles; simple work is finished in a single session.

### Minimal messaging convention

A dispatch carries the task ID, goal version, the executor, goal/acceptance criteria, workspace, permission boundary, and the place to return results; a result carries status, artifacts, evidence, unfinished items, and next step. The Chief judges whether something was created, sent, and completed by what the host actually returns; sent does not mean read, and a reply does not mean acceptance. If the host cannot prove an event, mark it unknown (`未知`) rather than forging it from a prompt.

When the user follows up or changes the goal, the Chief updates the version and relays it to the affected sessions through the messaging/follow-up-task capability the host actually has available at the moment; if it does not support relaying during a run, record it as pending, inject it the next time that is possible, or stop first. You cannot assume that the message was read or that the old execution stopped immediately. When several people edit files at the same time, the workspaces and write boundaries must be kept distinct.

## Different capabilities on the same host

- Codex: the in-session trial already in this repository actually used the main agent to create, wait for, send follow-up tasks to, and collect results from sub-agents; this is an observation of the Codex environment used this time, and does not prove that other Codex products, configurations, or versions support the same interface. The current local `codex exec` help shows support for resuming saved sessions; the existence of a command does not prove cross-restart background scheduling.
- Claude Code: the official docs describe [subagents](https://code.claude.com/docs/en/sub-agents) with independent context; its [agent teams](https://code.claude.com/docs/en/agent-teams) support messaging and task coordination between teammates, but the documentation marks them as experimental and off by default. Specific enablement, availability, and recovery limits are to be confirmed by testing on the target version.
- Different sessions may not be able to talk to each other directly: if only the main agent can coordinate, use `sub-task → Chief → another sub-task`. For handoffs inside the same host, first verify its tools and scope, and only then consider adding a file mailbox or another adapter.

## When code outside the host is needed

Sub-agent messages while a task is in progress and **running continuously across time and processes** are different capabilities. For the Chief to keep working after its turn ends, the host or an external runtime must wake it again when a result, a timer, or an external event occurs; some authoritative place is also needed to store the goal, tickets, and wait conditions. Without these two, a prompt does not execute by itself.

Verify the minimum viable setup first: create a sub-task → collect the result → send for review/rework → the user corrects midway → the second item in the queue continues. Only after that, test wake-up after idle, periodic inspection, memory reads, and restart recovery. Reuse a host mechanism if it exists; if it is missing, first add observable, durable scheduling capability, rather than building every event source and control plane on day one.

## Cross-harness: not a prerequisite for the first version

When one host really needs to call another, prefer a simple handoff: the Chief sends one assignment card using a process/adapter method its environment supports, and the other agent outputs a result and evidence; treat this as one execution attempt. If continuous two-way messaging or cross-machine operation must be supported, then consider gRPC, which the user knows well, or another transport. gRPC solves how messages are transported between processes; task ownership, received/processed, retry de-duplication, permissions, cancellation, state persistence, and unknown side effects still have to be defined. When these semantics are needed, reliability cannot be claimed on the strength of a protocol name alone.

A unified assignment card can be reused across hosts, but do not first design a general protocol covering all harnesses. Get one real host working first, then use the real differences of a second host to decide the adapter interface.

## Mapping to dsh-superagent's code

| Upstream part | What it does | How we can handle it first |
| --- | --- | --- |
| Source, Trigger, Thread | Receive external events, correlate conversations, record and de-duplicate | Reuse the host's existing sources; the first version can start from manual input |
| Eval, Policy, Mandate | Judge requests, sources, and authorization scope | The first version keeps the user's goal and permissions; complex external admission is implemented when sources are connected |
| Ticket, Assignment | Record work status and which executor it was given to | Prefer the host's task objects; otherwise add a lightweight authoritative record |
| Executor, Session | Work sessions, directories, tools, and concurrency | Reuse the host's native sub-agents and isolation capabilities |
| Outbox, Notices | Durably deliver results and notify the appropriate sessions | Prefer host receipts; when they are missing, add a minimal message record/delivery |
| Setup, Settings, Panel | Probe configuration, install, view pending items | First build a setup/doctor that can actually be verified; the panel can come later |
| Restart and failure handling | Distinguish waiting, failure, retry, and recovery | Treat as an acceptance condition for background use; not to be assumed by Markdown |

Sources: [domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md), [execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md), [architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md). Upstream relies on DeepSeek Harness; the project's own code and the session/tools provided by the host are two separate parts; the fact that its idle tickets wait for a trigger does not mean the continuous goal loop envisioned by this project has been verified.
