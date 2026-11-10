# 在工作区配置 Roundtable Work

适用于“把团队装到这个项目 / 配置团队 / 调整政策”。只做能验证的步骤；做不到的写成缺口，不声称已安装。

## 1. 检查现状（只读）

- 工作区是否已有 `.roundtable/team.md`、`.roundtable/policy.md`；有就读取并在其基础上修改，不覆盖。
- 本 skill 安装在哪些宿主目录：`.claude/skills/roundtable-work/`（Claude Code）、`.agents/skills/roundtable-work/`（Codex 等）。Claude Code 子代理在 `.claude/agents/rt-*.md`。
- 若能访问 Roundtable Work 源仓库，可运行 `node <源仓库>/scripts/install.mjs --target <工作区> --dry-run` 预览，再去掉 `--dry-run` 安装；`node <源仓库>/scripts/doctor.mjs --target <工作区>` 检查结果。
- 对照 [宿主映射](harnesses.md) 列出当前会话真实可用的委派、消息、等待和唤醒工具。

## 2. 收集配置

已有事实不再问。缺失且影响授权或验收的，逐项问用户：

1. 团队服务哪个工作区，长期目标与验收是什么？
2. 哪些动作无需确认，哪些必须先问（合并、发布、对外消息、删除）？
3. 需要哪些角色；Chief 可以自主开几个临时 session？
4. 预算与停止条件是否沿用默认值？
5. 是否启用外部事件或定时巡检？默认都不启用。

不在对话中索取凭据。默认不自动合并、部署或对外发送消息。

## 3. 写入配置

- 没有 `.roundtable/` 时用本 skill 的 [team](../templates/team.md) 与 [policy](../templates/policy.md) 模板创建；创建 `tickets/`、`state/`、`memory/` 目录。
- 已有文件：先展示拟修改的差异，经用户同意再改；无法解释的现有设置保留。
- `.roundtable/` 可能包含项目私有信息，是否提交到 Git 由用户决定。

## 4. 首轮验收

用一个低风险、可在本地验证的小目标跑一遍：Chief 建工单 → 委派开发 → 独立审查（必要时打回一次）→ 原作者返修 → 写续行记录。记录每一步的真实回执。然后让用户在会话结束后观察：没有宿主唤醒能力时，团队不会自己继续，这一点要写进交接。

## 5. 交接给用户

报告：安装位置、配置文件、启用的角色与权限、实际验证过的能力及证据、未支持或未验证的能力、如何暂停与撤销（删除 skill 目录和 `.roundtable/` 即可卸载）、下一步建议。未运行的检查标“未运行”。
