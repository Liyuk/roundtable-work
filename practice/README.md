# Practice: run a studio rehearsal in an existing multi-agent harness

This is an executable experiment protocol, not a standalone background service. The harness must actually support creating agents, sending tasks, and receiving results; this project does not provide those tools. Use the real tool names of the current harness, and do not copy another platform's API. The example is a document task inside a sandbox with no external side effects.

## Task card

- Goal: write a short description of a fictional to-do tool, containing a goal, three acceptance conditions, and one risk.
- Workspace: a temporary directory specified by the user; do not read or write real project data and do not access external accounts.
- Chief: after receiving the task, create the task card and assign it to the developer; after receiving the result, assign a reviewer to check it independently. If acceptance conditions are missing, have the developer fill them in; deliver once it passes.
- Developer: following the [shared instructions](../.agents/skills/roundtable-work/prompts/shared.md) and the [developer instructions](../.agents/skills/roundtable-work/prompts/roles/developer.md), write the file and report the actual path.
- Reviewer: following the [shared instructions](../.agents/skills/roundtable-work/prompts/shared.md) and the [reviewer instructions](../.agents/skills/roundtable-work/prompts/roles/reviewer.md), review the file against the task card, point out what is missing, and give a verdict of pass (`通过`) or send back (`打回`).
- Budget: at most two runs per role; stop and report when there is no permission, no progress, or the harness cannot wake up.

## Steps and evidence

1. The Chief records the goal and version and uses the harness to create a developer session; the log records the time, tool calls, the actual session ID, and the task content.
2. The developer confirms the claim, writes the file, and reports the file and checks; the Chief receives the completion event. Do not mark a task as claimed merely because text was sent.
3. The Chief creates a review session and delivers the ticket and the file path, without passing along fabricated results. The reviewer reads the actual file and submits an independent conclusion.
4. If it is sent back, the Chief sends the specific issues to the original developer to continue, and then submits it for review again. After it passes, the Chief gives a delivery card against the original goal.
5. Keep the event order, every message, the actual files, and the steps not executed. Record whether the Chief was woken naturally by a completion notification; if the main session waited actively or a person triggered it, state that explicitly, and do not advertise it as autonomous background wake-up.

## Three levels of verification

- **In-session rehearsal**: use multi-agent tools in the current conversation to run the flow above; it can verify the division of labor, messages, and review; continued running after the conversation ends is outside what it proves.
- **Harness continuation test**: let the main session end or go idle and wait for the harness to wake it automatically when a subtask result arrives; record the facts and any timeouts. Without such support, mark it as failed or unsupported.
- **Cross-restart test**: after restarting the harness or control layer, recover unfinished tasks, deliveries, and reconcile side effects. It must be tested for real in a dedicated, controlled environment, and cannot be extrapolated from an in-session rehearsal.

If a review session cannot be created or the execution result cannot be seen, record the failure directly; fabricating evidence of studio operation is forbidden.
