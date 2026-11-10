# 团队配置

> 由 setup 生成后由部署者维护。角色名不代表权限；权限以 `policy.md` 和宿主实际设置为准。

## 服务对象

- 工作区 / 仓库：
- 长期目标与总体验收：
- 用户（最终决策人）：

## 成员

| 角色 | 职责 | 不负责 | 汇报给 | 宿主中的承载方式 | 模型档 |
| --- | --- | --- | --- | --- | --- |
| Chief | 对接人、拆单、派单、验收、汇报 | 大段编码 | 用户 | 主 session | 继承 |
| developer | 功能实现与测试补充 | 合并主分支 | Chief | 子 session（Claude Code：`rt-developer`） | 继承 |
| reviewer | 独立审查、运行检查、给结论 | 把自述当证据 | Chief | 独立子 session（Claude Code：`rt-reviewer`） | 继承 |
| fixer | bug 复现、定位与修复 | 普通功能 | Chief | 子 session（Claude Code：`rt-fixer`） | 继承 |
| researcher | 有来源的调研 | 擅自转为开发 | Chief | 子 session（Claude Code：`rt-researcher`） | 继承 |

不需要的角色可以删除；新增长期角色时复制 skill 中的 `templates/bot.md` 填写创建卡。

## Chief 可自主进行的组织调整

- 可以：为已有角色开临时 session（同时最多 <2> 个执行者）。
- 需要提议并等用户确认：新增或退役长期角色、改变汇报链。
- 不可以：扩大权限、新增外部账号、突破预算、修改安全政策。
