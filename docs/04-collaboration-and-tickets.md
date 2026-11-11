# Collaboration, Tickets, and Handoff

## Choosing Between Group Chat and Point-to-Point

| Mode | Suited for | Advantages | Costs and handling |
| --- | --- | --- | --- |
| Group chat | Multi-perspective discussion, clarifying goals, showing interim results | Shared context, cross-role discovery of omissions, observable by people | Broadcasting consumes context; speaking easily loops, people rush to answer, and responsibility is unclear; limit the topic, the speaking budget, and have one closing owner |
| Point-to-point | Explicit delegation, direct submission for review, sensitive or large-context work | Clear responsibility, concise information, execution can run in parallel | Private chats are invisible to the group; delegations, deliveries, and key conclusions must be written into the authoritative ticket |
| Multi-session parallel | Independent development, fixing, research, and review | Context isolation, no mutual blocking, different models can be used | Duplicate execution, file/migration conflicts, late results, coordination cost; state the write scope and target version explicitly, and order conflicting work by dependency |

Default to point-to-point handoff and project important results into the task view; group chat is an optional coordination interface. **@-mentioning someone in a group is not a delegation**: an associated assignment must be created, with delivery, claiming, execution, and results recorded; if there is no host tool guarantee, mark it explicitly as unguaranteed. A suggestion from a group discussion becomes work only when it has an owner and a task; do not treat group notifications as authoritative state.

## The Ticket Object

A ticket has a stable ID, a parent goal and version, the user's own words and the organized goal, acceptance criteria, scope and prohibitions, a single owner, risks, a permission snapshot, budget, dependencies, workspace, status, artifacts, and evidence. See [ticket.md](../.agents/skills/roundtable-work/templates/ticket.md) for the template. When a person changes the goal, record a new version and deliver the revision to active assignments; **delivery, claiming, and actual application** are each recorded as events. Keep results from the old version, mark the version they are based on, and judge whether they are still valid.

Status expresses "what is being waited on". The unified vocabulary for ticket status, delegation events, delivery status, and continuation decisions is governed by [Shared behavior](../.agents/skills/roundtable-work/prompts/shared.md#状态词表全团队统一), and this document does not redefine it. Status is only a projected view; the reason, owner, next action, and wait condition must each be listed separately. `ready` means submitted and awaiting confirmation, and `done` must have the defined acceptance evidence; how PR closure, merging, and goal completion map is made explicit by deployment rules.

## Delegation, Relay, and Reclaiming

1. The Chief or an authorized lead first checks dependencies, the writable file scope, budget, risk, candidate roles, and workspace conflicts.
2. Transactionally create the assignment and the message to be sent, assigning a stable ID, target version, and idempotency key; delegate to one primary executor at a time.
3. Record `sent → delivered → acknowledged → started` separately; when no receipt arrives before the timeout, re-deliver, reassign, or prompt according to host capabilities; a message being picked up does not mean it is complete.
4. When starting, the executor checks the assignment card and submits [delivery.md](../.agents/skills/roundtable-work/templates/delivery.md); mark uncertain external actions `unknown`, to be verified by the coordinator, and do not blindly rerun them.
5. Output goes to independent review; when review sends it back, the original author still fixes it, and anything beyond the round limit or with major disagreement goes to the superior. The verdict records which version/HEAD it is based on, the execution evidence, and what was not done.
6. After passing, deliver according to permissions and write the result back to the ticket and the sender; if code changes after review, the validity of the review must be re-judged.

A delegation allows different purposes such as work, consult, and notify: only work establishes delivery responsibility; a notification does not automatically confer authority. When cancelling, reclaiming, or reassigning, record the reason, the current state, and unconsumed inputs; make sure the original executor has stopped or its fence is invalidated, to avoid double writes.

## Direct Handoff and Multi-Level Reporting

Within authorization, an executor may send a structured handoff directly to the reviewer, while also giving the management chain a queryable status event; ordinary handoffs need not be relayed through all superiors. Escalations involving the goal scope, permissions, cross-team conflicts, or budget go to the corresponding lead. Only the party authorized by the deployment decides what goes external; team messages, group discussions, or intermediate reports cannot expand that authorization.
