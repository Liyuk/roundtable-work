# Roundtable Work

**让一支 Agent 团队理解目标、持续推进，并交出可验证的结果。**

Roundtable Work（`roundtable-work`）是一套装进现有 Agent 宿主（Claude Code、Codex 等）的工作方式：一个 Chief 负责目标与判断，开发、修复、审查、调研等角色在独立 session 中执行，用统一的工单、委派卡、交付卡和续行记录交接。它从用户的工作约定与研究，以及 dsh-superagent 的公开原型中提炼。

**状态：v0.2 · 可安装的 skill 与配置；没有后台运行时。** 安装后，团队在一个活跃会话内运作；回合结束后能否被自动唤醒取决于宿主，未经实测不能承诺。

## 给 Harness 安装

需要 Node.js 24。获取本仓库后，把 skill 装进你的工作区：

```bash
git clone https://github.com/Liyuk/roundtable-work.git
cd roundtable-work
node scripts/install.mjs --target /path/to/workspace --dry-run
node scripts/install.mjs --target /path/to/workspace
node scripts/doctor.mjs --target /path/to/workspace
```

安装内容：

| 位置 | 用途 |
| --- | --- |
| `.claude/skills/roundtable-work/` | Claude Code 发现的 skill（提示词、模板、参考） |
| `.claude/agents/rt-*.md` | Claude Code 子代理：`rt-developer`、`rt-fixer`、`rt-reviewer`、`rt-researcher` |
| `.agents/skills/roundtable-work/` | Codex 及其他读取 Agent Skills 目录的宿主 |
| `.roundtable/team.md`、`policy.md` | 本部署的角色、授权、预算与停止条件（属于你，重装不会覆盖） |
| `.roundtable/tickets/`、`state/`、`memory/` | 宿主没有任务系统时的工单、续行记录与记忆 |

只装一个宿主用 `--harness claude` 或 `--harness codex`；升级加 `--update`。`.roundtable/` 可能含项目私有信息，是否提交由你决定。

然后在工作区启动宿主：

- **Claude Code**：在工作区运行 `claude`，确认 skill 列表里有 `roundtable-work`。直接说“用 roundtable-work 推进：<目标与验收>”。Chief 会通过 `Agent` 工具把工作派给 `rt-*` 子代理，并用另一个子代理做独立审查。
- **Codex**：在工作区运行 `codex`，skill 从 `.agents/skills/` 发现；也可以直接说“阅读 `.agents/skills/roundtable-work/SKILL.md` 并按它推进：<目标>”。
- **其他宿主**：让 Agent 读取 `SKILL.md`。没有子 session 工具时，它会降级为单 session 并把审查标为“自查”。

第一次使用建议先说“用 roundtable-work 配置团队”，让 Agent 按 [配置流程](.agents/skills/roundtable-work/references/setup.md) 检查宿主能力、填写 `policy.md`。完整安装、配置与验收说明见 [SETUP](SETUP.md)。

在本仓库内试用：`.claude/skills/roundtable-work` 已是指向 skill 源目录的符号链接，Claude Code 可直接发现；需要子代理时运行 `npm run setup -- --target .`（生成的 `.claude/agents/` 与 `.roundtable/` 不在版本控制中）。

## 运行时包（Skill）

所有运行时指令都在 [`.agents/skills/roundtable-work/`](.agents/skills/roundtable-work/SKILL.md)，可整体复制到任何工作区：

- 指令：[共享行为](.agents/skills/roundtable-work/prompts/shared.md) · [Chief](.agents/skills/roundtable-work/prompts/roles/chief.md) · [开发](.agents/skills/roundtable-work/prompts/roles/developer.md) · [修复](.agents/skills/roundtable-work/prompts/roles/fixer.md) · [审查](.agents/skills/roundtable-work/prompts/roles/reviewer.md) · [调研](.agents/skills/roundtable-work/prompts/roles/researcher.md)
- 模板：[工单](.agents/skills/roundtable-work/templates/ticket.md) · [委派卡](.agents/skills/roundtable-work/templates/assignment.md) · [交付卡](.agents/skills/roundtable-work/templates/delivery.md) · [续行记录](.agents/skills/roundtable-work/templates/checkpoint.md) · [团队](.agents/skills/roundtable-work/templates/team.md) · [政策](.agents/skills/roundtable-work/templates/policy.md) · [角色创建卡](.agents/skills/roundtable-work/templates/bot.md) · [记忆候选](.agents/skills/roundtable-work/templates/memory.md)
- 参考：[宿主能力映射](.agents/skills/roundtable-work/references/harnesses.md) · [配置流程](.agents/skills/roundtable-work/references/setup.md) · [Skill 发现](.agents/skills/roundtable-work/references/skill-discovery.md)

## 核心原则

- 人给方向和授权；团队在范围内自己决定下一步，真正需要判断时再打断人。
- 回合结束不等于目标完成；已发送、已领取、已执行、已交付、已验收是不同事实。每回合以续行记录收尾：`continue / wait / ask / done / stop`。
- 人格和提示词描述行为；权限、预算、任务状态与安全边界由宿主和运行时强制执行。
- 允许主动发现和改进，但有来源、授权、预算、去重、验收及明确停止条件。
- 复用宿主已有能力；同一项工作只有一个调度和状态权威。

## 设计文档

[文档索引](docs/README.md) 按主题列出全部设计文档与演练记录。建议先读 [总体方案](docs/01-architecture.md)、[单一 Harness 优先](docs/15-single-harness-communication.md) 和 [提示词与工程](docs/14-prompt-to-runtime.md)。

## 项目维护

使用 Node.js 24 运行 `npm ci` 和 `npm test`：测试覆盖安装脚本与诊断，并检查 Markdown 本地链接以及 skill 目录不向外链接。`npm run doctor` 只读检查 Node、Git 及候选宿主命令；加 `--target <工作区>` 检查安装结果，`--json` 输出机器可读结果。诊断不检查模型登录，也不能证明后台唤醒或持久委派可用。工作流与贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目采用 [MIT 许可证](LICENSE)。
