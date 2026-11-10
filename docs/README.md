# 设计文档索引

运行时指令以 [skill 目录](../.agents/skills/roundtable-work/SKILL.md) 为准；这里的文档解释为什么这样设计，以及尚未实现的部分。同一概念只在“权威文档”中完整定义，其他文档引用它。

| 主题 | 权威文档 | 相关 |
| --- | --- | --- |
| 目标、架构、两个循环、决策边界 | [01 总体方案](01-architecture.md) | [07 来源与差异](07-sources.md) |
| Chief / Bot / Session / Ticket / Assignment 概念 | [02 团队与会话](02-team-and-sessions.md) | [角色创建卡](../.agents/skills/roundtable-work/templates/bot.md) |
| 续行判断、触发来源、记忆分层 | [03 自主循环与记忆](03-autonomy-and-memory.md) | [11 Chief 持续循环](11-chief-continuous-loop.md)（人机分工、多 session 取舍）· [12 事件与记忆](12-events-and-memory.md)（外部事件格式、写入与召回时机） |
| 状态词表、委派与交接 | [共享行为](../.agents/skills/roundtable-work/prompts/shared.md) | [04 协作与工单](04-collaboration-and-tickets.md)（群聊与点对点、回收、多层汇报） |
| 执行器、权限、幂等与恢复 | [05 执行与安全](05-execution-and-safety.md) | — |
| 组织扩缩与多层汇报 | [08 组织调整](08-organization.md) | [10 工作室演化案例](10-evolving-studio.md) |
| 提示词组装、宿主缺口、工程路线 | [14 提示词与工程](14-prompt-to-runtime.md) | [15 单一 Harness 优先](15-single-harness-communication.md) · [宿主映射](../.agents/skills/roundtable-work/references/harnesses.md) |
| 安装与配置 | [SETUP](../SETUP.md) | [配置流程](../.agents/skills/roundtable-work/references/setup.md) |
| Skill 发现 | [16 Skill 发现](16-skill-discovery.md) | [运行时流程](../.agents/skills/roundtable-work/references/skill-discovery.md) |
| 评测与路线 | [06 评测与路线](06-evaluation-and-roadmap.md) | [演练协议](../practice/README.md) |

## 演练记录

- [会话内多 Agent 演练](../practice/2026-11-10-session-trial.md)：派发、独立审查、打回与返修。
- [连续队列演练](../practice/2026-11-10-queue-trial.md)：顺序任务与中途修订。
- [单一宿主演练](../practice/2026-11-10-native-harness-demo.md)：同一宿主原生工具的派单、纠偏、回收。
- [Sonnet A/B 演练](../practice/2026-11-10-sonnet-ab-trial.md)：v0.2 设计与原设计在同一目标上的对照，以及据此做的修订。
- [工作室预设](../profiles/studio/README.md)：从真实工作约定抽象的角色与规则（脱敏）。
