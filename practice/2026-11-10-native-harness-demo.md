# Rehearsal on a single harness: dispatch, course correction, and collection

Date: 2026-11-10. The task was a fictional book-club event. The main agent in the current session acted as Chief, and two subagents executed and reviewed respectively; all of them used the native collaboration tools of the same harness. No gRPC or message server was added.

## What actually happened

1. The Chief created an executor and dispatched D1: write the event goal and two acceptance conditions in a temporary directory. The executor read the shared and developer instructions, created and read the plan, and returned the path and check results.
2. The Chief used the harness's follow-up task tool to send the original executor a simulated user course correction: target version v2 adds an attendee cap, and continue with D2, writing a checklist based on v2.
3. The original executor updated the plan and wrote the checklist, read both files, and reported back. The sending and handling here both have evidence in the current session's messages; durable delivery after a harness crash was not tested independently.
4. The Chief created an independent review session and provided the target version, acceptance conditions, and the paths of the two files. The reviewer actually read the files, confirmed that the v2 constraint and the checklist were consistent, and gave a pass (`通过`); it only checked the documents and did not carry out the actual event.

## Conclusions and boundaries

The current environment can, **inside an active session**, dispatch subtasks, receive results, send follow-up tasks to an existing subagent, create a separate reviewer, and collect its results. In this run the Chief explicitly invoked waiting and follow-up tasks; this is not proof of long-running operation without human intervention.

There was no testing of real GitHub/webhooks, scheduled patrols, wake-up after the session ended, recovery after restart, cross-harness operation, or an independent memory store; no v1 snapshot was saved. The simulated input in this run was not a message from an external user, and there were no real external side effects. This rehearsal shows that native tools can carry one handoff loop; it does not mean that other Codex versions or Claude Code environments automatically have the same capability.
