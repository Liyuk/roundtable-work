# 来源、脱敏与证据边界

## 项目材料

- 用户提供的工作约定：用户提供的本地文件，描述真实运行中的职责、工单、模型分工、权限、审查及反复补充的规则。本文档只提炼通用工作方式；不复制账号、工单、主机、内部路径、密钥或业务信息。
- 用户提供的工作量报表：用户提供的工作量统计页面；可读作个人运行记录，但未独立审计。报表明确提示挂起认领会抬高忙碌时长、审查时长有估算。不可将工单跨度视为执行时长。报表不随本仓库公开复制。
- 用户提供的既有研究：覆盖目标与交付、共享记忆、多 Agent 调度和宿主接入；部分研究基于公开资料和静态源码，不等于运行实验。
- 用户观察：把类似架构放入 OpenMausBot 后，目标未完成时有时需人催促。未获该运行的日志，具体原因未知。

## 外部资料

- [dsh-superagent README](https://github.com/deepseek-ai/dsh-superagent-prototype)：项目声明是研究原型，与内部实现和文章有差异。
- [setup](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/SETUP.md)、[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[授权](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)、[执行](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)、[提示词](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/004-prompts.md)、[架构](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/007-architecture.md)：截至 2026-11-10 阅读的主分支；会变化。其文档指出命令包装和目录不是安全边界。
- [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：其产品说明及项目自身文档，具体能力需按部署版本实测。

以上材料只提供设计依据；本仓库新增的状态机、续行、记忆、组织变化和模板均是**提案**。没有安装或运行对照实验，不声称已验证优于任何现有项目。
