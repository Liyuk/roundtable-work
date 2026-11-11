# External events, the continuous queue, and replaceable memory

Status: candidate design. Any webhook, queue, storage, or wake-up mechanism must be provided by the chosen host or by a later implementation; this repository currently contains no receiving service.

## How the outside world gets involved

The user can keep refining the goal through conversation, and can also configure sources such as GitHub, other systems' webhooks, and timer events. Each source first verifies the sender and scope through its adapter, then translates the input into a unified event: `source / source_event_id / event_type / actor / resource / occurred_at / received_at / payload_ref / trust / correlation`. A reference to the raw input and a receipt record are stored, and events are de-duplicated by source and event ID; retries and out-of-order delivery must be visible.

Take GitHub as an example: issue creation, comments, PR reviews, and CI can all be event sources; the actual way of listening (webhook, host connector, notification API, or manual import) is chosen at deployment time. If a webhook is used, a real receiving service is needed to verify signatures, restrict sources, acknowledge quickly, enqueue durably, retry, and stay idempotent; you cannot claim that a real request was received just because a test wrote `webhook`.

Once an event arrives, the Chief decides: link it to an existing ticket, create a new ticket within the granted authority, treat it as context only, ignore it, or ask the user for a decision. A follow-up that clearly points to existing work goes to that work's owner first; when no link can be determined, events are not merged automatically on topic similarity alone. External text by itself does not expand permissions. When the user changes the goal, a new version is produced, recording what was delivered, read, and adopted, and old artifacts are rechecked. People can pause, correct, or cancel work at any time; that action must be recorded just like a planned event.

## Continuous queue processing

On each wake-up the Chief first handles user corrections, returned sub-task results, and urgent failures, then picks the work that can move forward according to authority, priority, dependencies, and resources. When one task is waiting for external review or user input, only that task is suspended; other non-conflicting tasks may continue. A result triggers acceptance or rework, and once it is done the goal and the queue are rechecked, without requiring the user to chase item by item. When the queue is empty, there is no authorized work, the budget is exhausted, or work is explicitly terminated, the Chief sleeps/stops and records the next trigger condition.

The actual guarantees for de-duplication, claiming, and state depend on the host and must not be assumed to exist; when multiple schedulers are provided, first designate a single authority for state and scheduling, so that the same event does not create two tasks. For high-risk operations or unknown external side effects, check first and then retry.

## When to write memory and when to recall it

**The memory store is an open choice**: host-provided memory, Markdown files, a database, or a standalone memory store can be used; no specific store is preselected. First verify its persistence, scoped access, source and versioning, deletion/revocation, exportability, conflict handling, and restart behavior; the store's retrieval results cannot replace task state and authorization.

| When | Action | Example |
| --- | --- | --- |
| The goal is revised or the user makes a long-term decision | Record the goal version and the user's decision; only the parts suitable for reuse become memory candidates | Output style, boundaries the user keeps stressing |
| A task is delivered, reviewed, fails, or is reworked | Save reusable lessons, together with evidence, scope of applicability, and uncertainty, as candidates | Context that a certain kind of handoff often omits |
| The organization or workflow changes | Record the reason, observation window, evaluation result, and rollback condition | Queue changes after a temporary capacity increase |
| A task is received, dispatched, fails, is reviewed, or the goal is revised | Retrieve relevant memory by goal, task type, project, and role | When revising an upstream requirement, check dependencies and the old acceptance criteria |
| A configured scheduled wake-up | The Chief reviews memory pending re-check, old goals, and unfinished items | At the start of each day's work, check what was left over from the previous day |

Candidate memory is first labeled as an observation or hypothesis, and one experience must not turn it into a general rule. Save the source, permissions, time, version, and expiry/revocation conditions; according to the capabilities the host offers, record recall, injection, and whether it was applied. The user can set the period and random sampling; randomness only discovers candidates, a timer is a wake-up source, and memory retrieval by itself does not wake a stopped process. Sensitive material is not written to a public repository.

## Trial run and gaps

The [continuous queue trial](../practice/2026-11-10-queue-trial.md) records the operations that actually happened in the current session, the simulated events, and the parts that were not verified. The following still need to be done later on the chosen host: real webhook signature verification/receipt, duplicate delivery and recovery, process restart, scheduled wake-up, persistence of a standalone memory store, and real user input.
