# Sources, sanitization and the evidence boundary

## Project materials

- User-provided working conventions: a local file provided by the user, describing responsibilities, tickets, model division of labor, permissions, review and repeatedly supplemented rules in real operation. This document distills only the general way of working; it does not copy accounts, tickets, hosts, internal paths, keys or business information.
- User-provided workload report: a workload statistics page provided by the user; it can be read as a personal operating record, but has not been independently audited. The report explicitly notes that suspended claims inflate busy time and that review time is estimated. The span of a ticket must not be treated as execution time. The report is not copied publicly with this repository.
- User-provided existing research: covers goals and delivery, shared memory, multi-Agent scheduling and host integration; part of the research is based on public materials and static source code, which is not the same as running experiments.
- User observation: after a similar architecture was put into OpenMausBot, a person sometimes needed to nudge it when the goal was unfinished. The logs of that run were not obtained, so the specific cause is unknown.

## External materials

- [dsh-superagent README](https://github.com/deepseek-ai/dsh-superagent-prototype): the project states it is a research prototype, and it differs from the internal implementation and articles.
- [setup](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/SETUP.md), [domain model](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md), [authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md), [execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md), [prompts](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md), [architecture](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md): the main branch as read on 2026-11-10; it will change. Its documents point out that command wrappers and directories are not security boundaries.
- [OpenMausBot](https://github.com/milind-soni/OpenMausBot): its product description and the project's own documents; specific capabilities must be tested against the deployed version.

The materials above provide only design grounds; the state machine, continuation, memory, organizational changes and templates newly added in this repository are all **proposals**. No comparison experiment was installed or run, and no claim is made that it is verified to be better than any existing project.
