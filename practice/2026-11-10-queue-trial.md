# Continuous queue and mid-course revision: an in-session rehearsal

Date: 2026-11-10. The work was a fictional event and involved no real project or account. It used the multi-agent tools in the current session, with the Chief as the main session and the executor and independent reviewer as subagents.

## What was actually executed

1. The Chief created an executor session and submitted three sequential tasks: Q1 write the requirements and acceptance for a fictional event; Q2 write a delivery checklist based on Q1; Q3 pause and wait for later information.
2. The executor created Q1 and Q2 in the system temporary directory, reported completion and the next step, and proposed one memory candidate: re-check the downstream checklist when upstream requirements change. This is a single observation and has not been verified as a general lesson.
3. The Chief used a follow-up message to inject a simulated external event EVT-1 together with a manual revision: add an attendee cap to the event. The "event" here is a test input within the conversation, **not an actual webhook**.
4. The same executor session received a follow-up task, modified Q1 and Q2, and then produced a Q3 summary explaining the revision and the use of the memory candidate.
5. The Chief created an independent reviewer; the reviewer actually read the three files and confirmed that Q2 referenced Q1, that the attendee-cap constraint appeared in both the requirements and the checklist, and that Q3 explained the change of goal. The Chief compiled the summary from its report.

## Actual observations and limitations

- This run executed a continuous queue, cross-role handoff, a change of goal, and context reuse within the same session inside an active conversation; follow-up tasks were sent explicitly by the Chief, so it cannot prove automatic scheduling without Chief intervention.
- No pre-change snapshot or timestamped independent event log was saved; therefore the final files can only prove final consistency, and cannot by themselves prove the full order of events, deduplication, or that the revision was handled at every stage.
- No HTTP receiver was run, and GitHub webhooks, signatures, event replay, long-running residency, or process restarts were not verified; no write operations on real external accounts were simulated.
- The memory candidate came from the context of the executor's own session; independent memory store access, cross-session recall, timed recall, or deletion were not verified.
- The original temporary files of the rehearsal are located in the local system temporary directory and are not a portable artifact; the above is a work record compiled by hand.

## Reproducible follow-up tests

After choosing an actual harness, record for each event its source ID, time, dispatch/claim/completion receipts, target version, and artifact snapshot; run separate experiments for duplicate webhooks, the user stopping midway, task failure, waking an idle main session, harness restart, and reloading the memory store. Note the observed result for each, and do not treat a candidate design as passed.
