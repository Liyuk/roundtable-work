# Roundtable Work

**让一支 Agent 团队理解目标、持续推进，并交出可验证的结果。**

Roundtable Work（`roundtable-work`）是一套以 Markdown 为主要载体的自主工作室设计与 setup 方案。它从用户提供的工作约定与研究，以及 dsh-superagent 的公开原型中提炼：如何组织 Chief、长期角色和任务会话，让团队在授权范围内循环判断、委派、执行、验收和改进。

**状态：设计草案，尚未实现、安装或验证。** 本仓库中的命令、配置、事件和接口均为候选契约，不能当作现成 CLI。相关实践已有运行经验，不能因此推断本项目已有同等运行能力。

## 从哪里开始

1. [总体方案](docs/01-architecture.md)：目标、架构、两层循环与关键决策。
2. [Chief、Bot 与会话](docs/02-team-and-sessions.md)：职责、创建与生命周期。
3. [主动循环与记忆](docs/03-autonomy-and-memory.md)：外部触发、可选定时机制、主动召回与停止条件。
4. [协作和工单](docs/04-collaboration-and-tickets.md)：群聊、点对点、委派、工单状态和交接。
5. [执行、权限与恢复](docs/05-execution-and-safety.md)：模型调用、执行回报、安全边界、故障与恢复。
6. [组织调整与多层汇报](docs/08-organization.md)：自主扩缩、角色调整、报告过滤。
7. [setup 方案](SETUP.md)：给配置 agent 的安装设计和验收流程。
8. [实验与实施路线](docs/06-evaluation-and-roadmap.md)：验证用户不催促时能否持续推进。
9. [来源与差异](docs/07-sources.md)：哪些来自现有资料、哪些是本方案的设计。

[工单模板](templates/ticket.md) · [委派卡模板](templates/assignment.md) · [交付卡模板](templates/delivery.md) · [记忆模板](templates/memory.md) · [工作室预设](profiles/studio/README.md) · [Chief 模板](templates/chief.md) · [角色模板](templates/bot.md)

## 核心原则

- 人给方向和授权；团队在范围内自己决定下一步，真正需要判断时再打断人。
- 回合结束不等于目标完成；已派发、已领取、已执行、已交付、已验收是不同事实。
- 人格和提示词描述行为，权限、预算、任务状态与安全边界由运行时强制执行。
- 允许主动发现和改进，但有来源、授权、预算、去重、验收及明确停止条件。
- 复用宿主已有能力；每个部署只允许一个组件对同一项工作的调度和状态拥有权威。

## 实践指令

[共享认知与交互](prompts/shared.md) · [Chief](prompts/roles/chief.md) · [开发](prompts/roles/developer.md) · [修复](prompts/roles/fixer.md) · [审查](prompts/roles/reviewer.md) · [调研](prompts/roles/researcher.md) · [多 Agent 演练](practice/README.md)

[指令组装方式](docs/09-prompt-assembly.md) · [真实会话演练记录](practice/2026-11-10-session-trial.md)

[从需求长出来的团队：运作逻辑与 工作室案例](docs/10-evolving-studio.md)

[Chief 持续循环：人的参与、多 session、等待和主动记忆](docs/11-chief-continuous-loop.md)

[外部事件、队列与开放记忆接口](docs/12-events-and-memory.md) · [连续队列演练](practice/2026-11-10-queue-trial.md)

## 项目维护

使用 Node.js 24 运行 `npm ci` 和 `npm test` 检查文档本地链接。工作流、讨论与贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，工程化下一步见 [实施建议](docs/13-engineering-next.md)。项目采用 [MIT 许可证](LICENSE)。
