# 参与贡献

## 从想法到交付

功能、设计和一般性改进先在 [Discussions](https://github.com/Liyuk/roundtable-work/discussions) 的 Ideas 或 General 讨论目标、方案与验收；形成共识后创建一个或多个 Issue。Issue 关联原 Discussion，明确范围、验收、依赖、负责人和可并行边界。执行者领取 Issue 后提交 PR，PR 使用 `Closes #编号` 关联 Issue，并附 Discussion 链接；多项任务分别关联。

Bug 可直接开 Bug Issue，写清复现步骤、预期与实际、环境和证据；领取后提交关联 Issue 的修复 PR。确有相关设计讨论时补充 Discussion 链接。安全问题不要公开贴敏感细节；先联系仓库维护者。

讨论、认领和关联是协作约定；模板帮助落实，不代表自动执行或绕过 GitHub 权限。PR 内容说明问题、实现、真实检查、未完成与风险；未经运行的检查不能标为通过。不要提交凭据、个人信息或私人项目记录。

## 本地检查

使用 Node.js 24（见 `.nvmrc`），运行 `npm ci` 和 `npm test`。测试覆盖安装脚本与诊断，并检查本地 Markdown 链接；并非 Agent 运行时测试。添加 npm 依赖或 GitHub Actions 时更新锁文件并保持 Dependabot 配置。

## 修改运行时指令

运行时指令和模板只放在 `.agents/skills/roundtable-work/`，`docs/` 写设计理由。skill 目录会被整体复制到用户工作区，因此其中的链接不能指向目录外（`npm run check` 会拒绝）。行为有实质变化时提升 `SKILL.md` 中的 `metadata.version`，`install.mjs --update` 和 `doctor --target` 依赖这个版本号。修改提示词后，最好在一个真实宿主里跑一次 [演练协议](practice/README.md) 并记录结果。
