# Design Document Index

Runtime instructions are governed by the [skill directory](../.agents/skills/roundtable-work/SKILL.md); the documents here explain why the design is the way it is, and which parts are not yet implemented. Each concept is fully defined only in its "authoritative document"; other documents refer to it.

| Topic | Authoritative document | Related |
| --- | --- | --- |
| Goals, architecture, the two loops, decision boundaries | [01 Overall Plan](01-architecture.md) | [07 Sources and Differences](07-sources.md) |
| Concepts: Chief / Bot / Session / Ticket / Assignment | [02 Team and Sessions](02-team-and-sessions.md) | [Role creation card](../.agents/skills/roundtable-work/templates/bot.md) |
| Continuation decisions, trigger sources, memory layers | [03 Autonomy Loop and Memory](03-autonomy-and-memory.md) | [11 Chief Continuous Loop](11-chief-continuous-loop.md) (human-machine division of labor, multi-session trade-offs) · [12 Events and Memory](12-events-and-memory.md) (external event format, write and recall timing) |
| Status vocabulary, delegation and handoff | [Shared behavior](../.agents/skills/roundtable-work/prompts/shared.md) | [04 Collaboration and Tickets](04-collaboration-and-tickets.md) (group chat vs. point-to-point, reclaiming, multi-level reporting) |
| Runners, permissions, idempotency and recovery | [05 Execution and Safety](05-execution-and-safety.md) | — |
| Organization scaling and multi-level reporting | [08 Organization Adjustment](08-organization.md) | [10 Evolving Studio Case](10-evolving-studio.md) |
| Prompt assembly, host gaps, engineering roadmap | [14 Prompt to Runtime](14-prompt-to-runtime.md) | [15 Single Harness First](15-single-harness-communication.md) · [Host mapping](../.agents/skills/roundtable-work/references/harnesses.md) |
| Installation and configuration | [SETUP](../SETUP.md) | [Setup flow](../.agents/skills/roundtable-work/references/setup.md) |
| Skill discovery | [16 Skill Discovery](16-skill-discovery.md) | [Runtime flow](../.agents/skills/roundtable-work/references/skill-discovery.md) |
| Evaluation and roadmap | [06 Evaluation and Roadmap](06-evaluation-and-roadmap.md) | [Practice protocol](../practice/README.md) |

## Practice Records

- [In-session multi-agent trial](../practice/2026-11-10-session-trial.md): dispatch, independent review, rejection and rework.
- [Continuous queue trial](../practice/2026-11-10-queue-trial.md): sequential tasks and mid-course revision.
- [Single-host trial](../practice/2026-11-10-native-harness-demo.md): dispatch, course correction and reclaiming with the same host's native tools.
- [Sonnet A/B trial](../practice/2026-11-10-sonnet-ab-trial.md): a comparison of the v0.2 design and the original design on the same goal, and the revisions made as a result.
- [Studio preset](../profiles/studio/README.md): roles and rules abstracted from real working conventions (anonymized).
