# Execution Model, Permissions, and Reliability

## How to Invoke Subordinate Execution Models

A role is not equivalent to a model. The Chief chooses **runner + model tier + permissions + workspace** according to task type, risk, quality requirements, availability, cost, latency, and tool capability. The active role-to-model routing table is the single source for the run's harness, model, and tier (see [17 Model Routing](17-model-routing.md)). For example, use a strong-reasoning tier for design; an economy tier for ordinary implementation; and a fixed, designated tier for high-risk independent re-checks. Model names and vendors are configured locally and determined through actual probing; model names in examples must not be taken as a promise of availability.

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

## Cancelled-Only Required CI

A required CI answer is cancelled-only when the CI provider returns `{ green: false, status: 'cancelled' }`: the provider decides that no required job concluded `failure` or `timed_out`, and the runtime never infers that from partial data. When the provider also exposes the optional `ci.rerunCancelled(pr)` capability, `runGates` requests one re-run and holds the issue as `waiting_external` instead of failing into the fixer chain. The budget is two re-runs per issue + head (`MAX_CI_RERUNS`), persisted as `ciReruns` on the gate record before the side effect is requested; a new head or tree resets it. Once the budget is used up, or when the provider exposes no re-run capability, a cancelled answer keeps today's behaviour: a genuine failure that fails closed. A real `failure` or `timed_out` status is never retried this way. Changing required check names or CI runner labels is out of scope unless the issue explicitly asks for it.

## Recovering a Paused Auto-Merge Monitor

The runtime auto-merge monitor (`runtime/rtd.mjs`, `monitorMain`) pauses new claims and merges while `state/rt-main-monitor*.json` holds a record. The record is written by the runtime itself; operators never write it by hand.

A squash merge is published as an unknown-outcome marker immediately before the merge and replaced after success:

- before the squash: `{ stage: 'merging', pr, head, tree, since }`, where `pr`/`head`/`tree` describe the validated merge context and `since` is a timestamp;
- after a successful squash: `{ stage: 'monitoring', mergeCommit }`.

A transient `squashMerge` error or a crash between those two writes therefore leaves a `merging` marker, not a permanent pause. On the next pass the runtime resolves that marker from the live pull request:

| Live state | Result |
| --- | --- |
| Pull request open, or closed without a merge | The squash did not land: the hold is cleared and work resumes. The merge entry point revalidates every gate and the live pull request immediately before any retry. |
| Merged, provider returns a merge commit | The record becomes `{ stage: 'monitoring', mergeCommit }` and the normal post-merge monitoring continues, including the red-main revert path. |
| Merged, no usable merge commit, main green | The hold is cleared. |
| Merged, no usable merge commit, main red or pending | The hold stays and one bug issue is opened (labels `type:bug`, `rt:self`; body names the pull request and the recovery command). |
| Pull request unreadable, malformed, or a legacy marker without `pr` | The hold stays, the attempt is counted in the marker, and one bug issue is opened once the marker is older than 15 minutes (`mergeUnknownTimeoutMs`) or after three passes. A legacy marker without a pull request number is reported immediately. |

The escalation is recorded in the marker (`escalation.inFlight`, then `escalation.done`) before and after the `createIssue` effect, so a crash in between does not create a second issue on the next pass. Only labels that exist in the repository are used; no label is created or added by the monitor.

### Operator Recovery Procedure

After checking the pull request and main by hand, clear a stale hold with the explicit clear mode. It requires no handler and no queue:

```text
rtd.mjs --work-root DIR --providers MODULE --clear-main-pause
```

It takes the same single-flight lock as a pass (so it cannot race a running pass), writes through the epoch-fenced state store, and clears both the persisted monitor record and the injected `pause` backend when the providers module exposes one. It is a successful no-op when nothing is set. It prints a JSON result and exits `0` on success, `75` when another pass holds the lock (inspect `holder`, retry later), and non-zero with a diagnostic on failure. Re-run it after fixing the reported cause; the next pass then resumes claims and merges.
