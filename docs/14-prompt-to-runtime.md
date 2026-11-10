# 提示词与工程如何配合

状态：设计与验收清单。提示词包可在支持 Skills 或文件读取的 Agent 内使用；这不等于本项目已提供持久调度系统。

## 可安装单元：Skill

运行时需要的全部指令都在 [Roundtable Work Skill](../.agents/skills/roundtable-work/SKILL.md) 目录内：`prompts/`（共享行为与角色）、`templates/`（工单、委派、交付、续行记录、团队与政策）、`references/`（宿主映射、配置流程、Skill 发现）、`agents/claude/`（Claude Code 子代理定义）。目录不链接外部文件（`npm run check` 强制），因此可以整体复制到任何工作区；[安装脚本](../scripts/install.mjs) 就是这样做的。`docs/` 是设计依据，运行时不需要加载。

## 指令如何组装

一次工作会话按以下顺序得到上下文：

1. 宿主系统规则、真实开放的工具与安全约束（宿主提供，本项目不能覆盖）。
2. Skill 入口：判断模式（Chief / 执行者 / 配置），只加载该模式需要的文件。
3. [共享行为](../.agents/skills/roundtable-work/prompts/shared.md)：协作、状态词表、证据等级与收尾纪律。
4. 选定的角色说明 `prompts/roles/<角色>.md`；Claude Code 子代理定义会直接指向它。
5. 部署配置 `.roundtable/team.md` 与 `policy.md`：角色、授权、预算、路由、触发。历史授权不能迁移为新授权。
6. 当前目标版本、工单、委派卡、相关记忆及来源。外部材料作为低信任数据。
7. 工具的真实回执和执行证据；状态更新依赖宿主的真实操作，而非模型声称。

动态目标与当前任务不写进永久角色身份。权限和安全由工具及宿主强制，提示词只是行为指导。该顺序参考 [dsh-superagent 的提示词组装](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md)，为本项目重写。

## 可先用提示词驱动的工作

Chief 读取目标及验收，决定拆分、优先级、角色、合理假设和下一步；使用宿主实际存在的子 session 工具委派，按委派卡交接；读取交付卡并发起独立审查；每回合写续行记录。宿主没有 session 能力时，不能假装存在独立审查者；单 session 自查不能称为独立审查。真实表现取决于模型、上下文和宿主，必须通过任务验证。

## 哪些需要宿主或工程

| 功能 | 最小要求 | 验证 |
| --- | --- | --- |
| 生命周期 | 创建、取消、观察 session，区分身份、会话和委派 | 启动子任务并查看真实结果 |
| 完成通知与等待 | 完成、失败和用户输入能送给正确 owner；空闲后能唤醒 | 让主会话空闲，再观察通知；不支持时报告 |
| 目标与工单 | 一个状态权威；目标版本、owner、验收、等待条件和证据 | 目标中途变化后检查旧结果版本 |
| 外部事件 | 接收、身份认证、授权判断、去重和关联 | 真实事件、重复事件和无权来源测试 |
| 定时唤醒 | 配置时间、时区、预算、过期及错过策略 | 到时触发、暂停和重启后处理测试 |
| 记忆 | 读取/写入/检索，来源与权限、有效期和删除 | 跨会话重载、冲突与修订测试 |
| 恢复 | 输入持久化、未知副作用对账、恢复或安全停下 | 任务运行中断、重启和重复投递 |
| 授权与隔离 | 权限在工具和宿主强制，账号/工作区受控 | 验证无权动作被真实拒绝 |
| 观测和预算 | 工作、等待、失败、费用、资源与人工介入可区分 | 与实际进程/事件交叉检查 |

## 工程路线

参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [dsh-superagent 的 setup](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/SETUP.md)、[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[执行机制](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)：

1. **已完成**：可复制的 skill 包、`install.mjs`（幂等、不覆盖用户政策）、`doctor.mjs --target`（检查安装结果与候选宿主命令）。
2. 固定首个宿主和版本，在其中跑通：Chief 派发 → 执行者交付 → 独立审查打回 → 返修 → 目标未完成时继续第二项；保存回执证据。
3. 主会话空闲后等待完成结果，再测试用户中途修改目标。无法唤醒或处理纠偏即记录失败和具体缺口。
4. 只对经验证的宿主缺口增加最薄适配；先定义权威状态与数据所有权，再测试重复事件、重启与未知外部副作用。
5. 逐项接入记忆、定时任务、外部触发和组织扩缩；第二宿主运行同一案例后，才稳定通用接口。

不要因为有角色提示词就声称后台团队可运行，也不要因为单次会话演练通过就声称自动恢复。Superagent 的公开实现是研究原型，其工单在 idle 时等待触发；这里的持续目标和组织演化是候选设计，不是对上游能力的概括。
