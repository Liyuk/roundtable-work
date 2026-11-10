# 从方案到可运行系统

状态：候选路线，2026-11-10。当前仓库主要包含设计和会话演练；没有可安装的持久运行时，也尚未实现 webhook、后台调度、真实跨进程恢复或宿主适配。

参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 [dsh-superagent 的 setup](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/SETUP.md)、[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[执行机制](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)，建议按以下顺序验证：

1. 固定首个实际宿主和版本，核查它的会话、授权、投递、完成通知、定时和恢复能力；编写真实探测、可重复 setup、升级及 doctor。
2. 对接一个权威状态源，实现或复用事件、准入、工单、委派、投递与回执；先跑一个可审查的真实闭环，不并行构造多个调度器。
3. 建立事件去重、未投递输入、结果回传、重启对账和未知外部副作用的测试；支持用户修订、停止和预算限制。
4. 实测主 session 空闲后唤醒、跨重启恢复、真实 webhook、独立审查返修和队列持续推进。报告模型、版本、费用、人工干预和未通过项。
5. 对第二宿主实测后再确定公共适配接口；记忆库保持可替换，检验来源、范围、过期、删除和重载。

Superagent 的公开实现是研究原型，具体版本和环境需单独验证；其工单在 idle 时等待触发。这里的持续目标和组织演化是 Roundtable Work 的候选设计，不是对上游实际能力或不足的概括。
