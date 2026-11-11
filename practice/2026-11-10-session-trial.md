# In-session multi-agent rehearsal record

Date: 2026-11-10. Goal: verify whether the current harness can support task dispatch, independent review, sending back, and a fix by the original author. The example is a fictional to-do tool description and involves no real business data.

## What actually happened

1. The main session, acting as Chief, used the current harness's `collaboration.spawn_agent` to create `practice_developer` and handed over task RTW-DEMO-1: write a temporary file with a goal, three acceptance conditions, and one risk. To test rework, the first draft deliberately contained only two conditions.
2. The developer reported actually creating `/tmp/rtw-demo/brief.md` and checking it; the Chief used `collaboration.spawn_agent` to create an independent `practice_reviewer`, providing the original goal and the file location.
3. The reviewer actually read the shared instructions, the reviewer role, and the file, found that the file had two acceptance conditions where three were required, and concluded with a send-back verdict (`打回`).
4. The Chief used `collaboration.followup_task` to send the defect back to the original developer; the developer added the third condition and read it back to check.
5. The Chief used `collaboration.followup_task` to have the original reviewer re-review; the reviewer reported a pass (`通过`) after reading, confirming the goal, the three acceptance conditions, and one risk. The Chief separately read the final file to check.

## Conclusions and boundaries

The execution above really happened, and the completion events and messages were visible in the current active session. The defect was set up in advance in order to verify the send-back; this does not prove that review is effective against naturally occurring complex errors. The main session used `wait_agent` to wait for results, and follow-up tasks were initiated explicitly by the Chief. Not verified: automatic wake-up after the main session ended, long-term session persistence, scheduled triggers, cross-process restarts, permission enforcement, external side effects, or real development tasks; the pi/Codex command-line adapters were also not tested. The temporary files are not permanent publication material.

Unresolved issues pointed out by the independent document reviewer: no specific harness installation adapter has yet been chosen and implemented; the actual assembly of role prompts and tools, durable dispatch, and idle continuation need to be verified in the target harness. This rehearsal does not change those states.
