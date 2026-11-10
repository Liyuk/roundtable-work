# Setup：把 Roundtable Work 装进一个宿主

> 已实现：把 skill（提示词、模板、Claude Code 子代理）安装到工作区，并生成 `.roundtable/` 配置。未实现：后台调度、回合结束后的自动唤醒、跨重启恢复。交给 coding agent 执行时，它必须按实际结果报告，未验证的能力不能写成已具备。

## 1. 安装（可执行）

需要 Node.js 24 和本仓库的一份副本。

```bash
git clone https://github.com/Liyuk/roundtable-work.git
cd roundtable-work
npm run doctor
node scripts/install.mjs --target /path/to/workspace --dry-run
node scripts/install.mjs --target /path/to/workspace
node scripts/doctor.mjs --target /path/to/workspace
```

| 选项 | 作用 |
| --- | --- |
| `--harness claude` | 安装到 `.claude/skills/roundtable-work/`，并在 `.claude/agents/` 写入 `rt-developer`、`rt-fixer`、`rt-reviewer`、`rt-researcher` 子代理 |
| `--harness codex` | 安装到 `.agents/skills/roundtable-work/`（Codex 及其他读取 Agent Skills 目录的宿主） |
| 默认 | 两者都装 |
| `--dry-run` | 只打印计划 |
| `--update` | 升级：刷新与新版本不同的 skill 文件和 `rt-*` 子代理 |

安装脚本可重复运行。`.roundtable/team.md` 与 `policy.md` 属于用户，任何情况下都不会被覆盖；本地改过的 skill 文件只有加 `--update` 才会被替换。卸载：删除上述 skill 目录、`.claude/agents/rt-*.md` 和 `.roundtable/`。

## 2. 配置（交给 Agent）

在工作区打开宿主，让 Agent 执行“用 roundtable-work 配置团队”。它会按 skill 内的 [配置流程](.agents/skills/roundtable-work/references/setup.md)：

1. 只读检查现有配置与当前会话真实可用的委派、消息、等待、唤醒工具（对照 [宿主映射](.agents/skills/roundtable-work/references/harnesses.md)）。
2. 只问缺失且影响授权或验收的问题：工作区与长期目标、免确认/需确认动作、角色、预算、是否启用外部事件或定时。
3. 修改 `.roundtable/team.md`、`policy.md`；已有设置先展示差异再改。不在对话中索取凭据，默认不自动合并、部署或对外发送消息。

## 3. 部署形态的选择

1. **宿主内 setup**（默认）：宿主提供 session、委派与通知，Roundtable Work 提供角色、规则和模板，宿主是唯一调度权威。
2. **宿主 + 薄适配**：宿主缺部分可观察能力时，用最小适配器补齐，并写明状态权威和失败边界。
3. **独立控制层**：仅在真实缺口经验证且有实现时启用；负责自己的状态、事件、授权和调度，不与宿主重复派单。

任何缺失的必要能力记录为缺口：无法可靠触发下一轮时不能承诺无人催促；无法限制权限时不能承诺安全的全自动。

## 4. 验收与移交

先在只读、观察或沙箱模式运行一个低风险目标：

1. 创建测试工单，确认用户身份、权限、版本和 owner。
2. 委派给执行者，看到发送、领取、启动及完成的真实回执；交付卡附实际检查。
3. 让独立审查退回一次，确认原执行者收到并修复；目标未完成时，Chief 不经催促继续，或在续行记录中写明具体等待条件。
4. 进阶（需要宿主或适配器支持）：注入可恢复故障、重复事件和进程重启；模拟用户修订目标、执行器不可用与无进展；验证增减角色的授权门槛。

交接给用户：运行方式、部署与权限、状态与记录位置、暂停与撤销方式、验证结果、未支持能力、下一步和实际运行成本。所有检查写明真实执行内容，未跑即标未跑。

## 诊断能证明什么

`npm run doctor` 只检查候选 CLI（node、git、claude、codex、pi、dsh）的版本命令；`--target` 额外检查安装文件与版本。它不检查登录凭据，也不能证明会话创建、通知、后台唤醒或权限控制可用——这些要按第 4 节实际跑一遍。
