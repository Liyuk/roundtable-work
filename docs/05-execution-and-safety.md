# Execution Model, Permissions, and Reliability

## How to Invoke Subordinate Execution Models

A role is not equivalent to a model. The Chief chooses **runner + model tier + permissions + workspace** according to task type, risk, quality requirements, availability, cost, latency, and tool capability. For example, use a strong-reasoning tier for design; an economy tier for ordinary implementation; and a fixed, designated tier for high-risk independent re-checks. Model names and vendors are configured locally and determined through actual probing; model names in examples must not be taken as a promise of availability.

Minimal adapter interface (design, not an existing API): `probe`, `start(assignment, profile, workspace)`, `observe(attempt_id)`, `send_input`, `cancel`, `recover`. Launch arguments use an argument array, and the task is supplied from a controlled file or stdin; untrusted input is not concatenated directly into a shell. Record the CLI and model versions, provider, configuration hash, working directory, start/end times, status, exit code, resource usage (when available), raw log path, and the conclusion. Sensitive data is redacted or not stored, according to permissions.

```text
Chief → create Assignment → role claims the ticket → choose an available route
      → execute pi/Codex in an isolated workspace → process-completion event
      → read structured conclusion and verification evidence → submit for review/rework → deliver
```

The minimal conclusion includes status (`完成` (complete) / `失败` (failed) / `阻塞` (blocked) / `部分完成` (partially complete) / `结果未知` (result unknown)), key points, changes, artifacts, check commands and their exit statuses, unfinished items, and next steps. Full logs remain available for inspection, and the Chief reads the summary by default; when a runner cannot provide a structured conclusion, mark it incomplete. The system should produce evidence from actual process exits and tool results, and must not trust the model's report alone.

Fallback is triggered only for predefined provider unavailability or recoverable faults, recording the original model, the error, the substitute model, and the attempt ID; before a new attempt picks up, first verify external side effects. If a high-risk review requires a designated model, it must not be silently downgraded. Output format, cost, and model capability vary by CLI/version, so setup must probe them in practice.

## Permissions and Isolation

The requester's identity and the authorization rules determine the ticket's Mandate; a Mandate includes the allowed repositories, workspaces, actions, budget, and validity period, and permissions can only be narrowed, never expanded by prompts, issues, or memory. By default, production deployment, merging into the main branch, and external messages are not enabled; actual long-term authorization must be configured by the deployer, and after revocation new actions are blocked. Before write operations, check the effective authorization and the target version, and at execution use an independent identity and least-privilege credentials.

A Git worktree makes it convenient to isolate parallel changes, but **it is not a security sandbox**; command blacklists and environment-variable scrubbing also cannot guarantee that access to production is prevented. Choose restricted users, file/network isolation, credential separation, branch protection, and auditing according to the risk; when capability is insufficient, forbid the related automatic operations or handle them manually. Do not put real hosts, internal paths, personal identities, secrets, logs, or private business data into templates that can be shared.

## Interruption and Idempotency

Events, state updates, and side-effect intents should be persisted atomically; sending uses an outbox plus idempotency keys and receipts. When a service or host restarts, first restore subscriptions and unprocessed messages, then check the actual state of processes, tickets, remote PRs/comments, and so on. Mark write operations whose result cannot be proven `unknown`, and retry or escalate only after reconciliation; when an external system provides no idempotency or query capability, do not claim exactly-once. Goal revision, cancellation, or role reclaiming should reject further writes from old attempts through version/lease fencing; when forced termination is impossible, disable the affected write operations and report.

Parallelism is limited jointly by the actual number of processes, CPU, memory, disk, inodes, workspace conflicts, and task dependencies; occupying a ticket is not the same as an executing process. Review and rework take priority, and concrete thresholds are configured by the deployment environment. A worktree can be cleaned up only after confirming it has finished and has no uncommitted work; the permissions to clean up, close, delete, and merge are each made explicit.
