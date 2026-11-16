# rt-loop v2 操作说明

本目录的文件将**整体复制到 `~/rt-loop`（同一路径，现有 worktree 继续有效）**。所有脚本从自身位置或 `RT_HOME` 环境变量推导根目录，没有硬编码 `rt-loop-next`。不要复制 `SPEC.md`/`ADDENDUM*.md`/`test/`/`.build-session`/`build*.log`；`config.env` 复制前确认是否要保留线上已有改动。部署前先停掉旧的 `rt-loop.sh`（它不使用 `locks/<n>.lock`，两者不能并存）。

GitHub intake + 自主决策 + 并行 worker。`rt-loop.sh` / `queue.txt` 保留为旧版，**v2 不使用**。

## 组成
| 文件 | 作用 |
| --- | --- |
| `rt-sched.py [--dry-run] [--once]` | 常驻调度器：每 `RT_POLL` 秒一轮（收尾 → ask 恢复 → 拉 issue → 认领 → 孤儿恢复 → 心跳） |
| `rt-work.sh <n> [base]` | 单 issue worker：worktree `wt/<n>`、分支 `rt/<n>-pi`、Chief 唤醒循环 + 后处理（decide/decompose/ask/gates/标签），持有 `locks/<n>.lock` |
| `bin/rt-gate0 <wt> <base> <n>` | Gate 0（确定性）：npm test、隐私、冻结字段计数（`gate0-frozen.txt`）、翻译方向、测试未削弱。`--scan-text <file>` 做纯文本隐私扫描 |
| `bin/rt-xcheck <wt> <base> <n>` | Gate 2：`codex exec --sandbox read-only`，首行 `XCHECK: pass|fail|unavailable` |
| `bin/rt-decide <n> <question-file>` | Opus 决策者，首行 `DECIDE: resolve|ask-owner|stop`；只决策，不实现不审查 |
| `bin/rt-labels-init [-n]` | 创建缺失标签（已存在的跳过；`-n` 只列出）。**部署者手动运行一次** |
| `bin/gh` | pi 侧受限 gh：只读 + `pr create/edit` + 评论（评论自动加 `<!-- rt:chief -->` 标记）；无 label/close/merge/ready |
| `bin/rt-merge <pr>` | **唯一**执行 `gh pr merge --squash` 的地方（无 `--admin`/`--auto`）。要求 `RT_MERGE_STEP=1` + `wt/<n>/.roundtable/state/gates.json` 全绿且 head 与 PR 一致；合并前重新核对 PR 状态。`RT_DRY_RUN=1` 只打印。退出码：0 合并/将合并、2 拒绝、3 跳过（已合并/关闭/hands-off）、5 需同步 main、6 CI 未绿、7 main 红 |
| `bin/rt-sync-branch <n>` | 把 `origin/main` **merge** 进 `rt/<n>-pi` 并普通 push（不 rebase、不 force）；冲突则中止并写 SUPERVISOR.md |
| `bin/rt-revert <sha>` | main CI 红且头提交是自动合并产物时：建 `rt/revert-<sha7>`、开 PR、等 CI、经 rt-merge 合并、评论原 issue、开 `rt:self` `type:bug` `priority:p0` 新 issue |
| `bin/rt-safety` | 安全文件检测器（stdin/参数里的文件名 → 命中列表，命中则退出 1） |
| `bin/rt-state <n> get/set/inc/reset` | 每 issue 持久计数器 `state/issues/<n>.json`（decide_n、fix_n、review_n、safety_n、merge_hold） |
| `bin/rt-tree <dir>` | 工作树内容的 git tree ID，用来证明“审查对象就是当前 head” |
| `bin/rt-wt <n> [base]` | 创建/复用 worker worktree |
| `status.sh` | 健康检查 |
| `test/run-all.sh` | 假 gh/pi/codex 的端到端测试（只写本地裸仓库，不访问 GitHub） |

## 模型路由（`config.env`）
模型路由唯一来源是 `config.env`：`bin/rt-agent` 在每次角色启动时生成「本轮路由事实」（每个角色的 harness 和模型，以及 DeepSeek 没钱时的 `RT_NOFUNDS_MODEL`）注入系统提示；`bin/rt-agent --routing-facts` 查看，`bin/rt-agent --check` 校验每个角色都配了模型（start-box.sh 启动前会跑）。提示词与政策文件只写档位（开发档、审查档、决策者档），不写模型名。

## 部署（由部署者做，本目录未执行）
1. `bin/rt-labels-init -n` 看清单，再 `bin/rt-labels-init` 建标签。
2. 先 `RT_HOME=$PWD ./rt-sched.py --dry-run --once` 看决策（只读，不写 GitHub）。
3. 旧 `rt-loop` 停掉后（`touch ~/rt-loop/STOP`，等其 worker 结束），在 tmux 里 `./rt-sched.py`。旧 `status.tsv` 的终态（done/stop/…）会被沿用；owner 之后的新评论会重新打开。
4. `./status.sh` 看状态；停：`touch STOP`（调度器不再认领，等 worker 做完才退出，**不会杀 worker**）；SIGTERM/Ctrl-C 只退调度器，worker 继续（重启后按 `locks/` 认领回来）。

## 自动合并（owner 决定）
done → Gate 0 → （高风险）Gate 2 → **Gate 1：必须是 Sonnet 在“当前 head 的文件树”上给出的 `审查结论：通过`**（`rt-delegate reviewer` 把 verdict+树 ID 记到 `wt/<n>/.roundtable/state/reviews.log`；没有就由 worker 自己跑一次 `rt-delegate reviewer`，卡片来自 issue 正文 + `git diff base...HEAD`；打回→修复轮；不可用→重试一次，仍不可用则只标 `rt:ready-to-merge` 不合并并记日志）→ 写 `gates.json` + PR 评论 `<!-- rt:gates -->`（含 `Result: pass` 与 `Head: <sha7>`）→ 安全文件则走 Opus（`APPROVE-MERGE` + 先发 `<!-- rt:opus-merge -->` 评论，否则留给 owner）→ `gh pr checks --watch --required`（`RT_CI_TIMEOUT`，红/超时=Gate 失败走修复轮，没有 required checks 则不合并）→ `bin/rt-merge`。合并后：`rt:merged`，堆叠中的后继分支用 `git merge origin/main` + 普通 push 更新并把 PR base 改回 main（冲突→中止、写 SUPERVISOR.md、状态 queued 唤醒 Chief）。`RT_AUTOMERGE=0` 可整体关闭；`RT_HANDS_OFF_PRS` 里的 PR 不碰。
堆叠：依赖 issue 已 CLOSED 即满足；依赖 PR 只是 `rt:ready-to-merge`（在等 CI/合并，且不是留给 owner 的）时仍可作为后备堆叠，但堆叠 PR 在其 base PR 合并前不会被合并。

## PR 清扫（ADDENDUM2）
调度器每轮在认领前扫描所有开放的 `rt/<n>-*` PR（不含 `rt:merged`/`rt:blocked`、无活跃 worker、issue 开放且未被 hold/ask）：head 上没有 gates 通过记录（`gates.json` 或 `<!-- rt:gates -->` 通过评论）→ 起 `rt-work.sh <n> --gate-only`（占一个 worker 槽）：复用/创建 worktree，落后 main 则 merge main，跑 Gate 0/1/2、等 CI、合并；失败或冲突则退化为带 SUPERVISOR.md 的普通 Chief 唤醒。瞬时 hold（base 未合并、main 红、同步）会在退避（`RT_SWEEP_RETRY`，默认 900s）后重试；`owner:*` hold 不再动。旧循环的终态（如 #16 `stop`）保持终态，除非 owner 之后评论。

## main 红灯
每轮读 main 最近一次完成的 CI：红 → `state/main_red`，暂停新认领与合并（revert 例外）；若头提交在 `state/merges.log` 里（我们自动合并的）→ 起 `bin/rt-revert`。绿 → 自动解除。

## 标签
`type:feature|bug`、`priority:p0|p1|p2`、`rt:running`（已认领/有 worker）、`rt:ask`（等 owner 回复）、`rt:self`（循环自己拆出的子 issue）、`rt:proposed`+`rt:approved`、`rt:ready-to-merge`（Gate 通过；CI 绿后自动合并，或因安全文件/Gate 1 不可用/无 required checks 等留给 owner）、`rt:merged`（已由循环合并）、`rt:blocked`（停了，回复即恢复）、`rt:hold`（已拆分，子 issue 全关闭后自动解除）、`rt:owner`（只给 owner，不认领）。`rt:go` 是旧标签，忽略。

## 决策流程（worker）
- Chief DECISION：`continue|wait|ask|done|stop|decompose|out-of-scope`。`ask` 第 2 行类别（`scope|credentials|destructive|direction`，没有 merge），第 3 行起问题。
- `ask`：`credentials|destructive` 直接 `<!-- rt:ask -->` 问 owner；`scope|direction` 或类别不合法（含已取消的 `merge`）→ 先 `rt-decide`（`resolve` 则写 SUPERVISOR.md 再唤醒一次；每个 issue 最多 `RT_DECIDE_MAX=2` 次，计数持久化，owner 回复后清零）。
- `stop`/无进展（连续 2 次唤醒无变化）/唤醒预算（`RT_MAXWAKE`）耗尽：问决策者一次，`resolve` 再唤醒，否则 `rt:blocked` + 评论原因。
- `decompose`：按 `state/subissues/NN-*.md` 创建 `rt:self` 子 issue（`sub:NN` 换成真实编号），父 issue `rt:hold`；子 issue 全关闭后调度器解除 hold 并唤醒父 issue 核对验收（DECISION `done` + 第 2 行 `no-pr`）。子 issue 列表在 `state/children/<父>`。
- `out-of-scope`：评论 + `rt:blocked`（不关闭；仅循环自己建的 `rt:self` 子 issue 会被关闭）。
- `done`：见上面“自动合并”。Gate 0 隐私/测试失败永远不能被覆盖，只走修复（最多 2 轮，持久化）；Gate 0/2 与 Gate 1 的分歧由 Opus 判 `VERDICT: real|false-positive`（覆盖需要 Gate 1 通过）。XCHECK `unavailable` 不阻塞。
- 所有 worker 发到 GitHub 的文本先过隐私扫描，不过则换成通用文案并写日志。

## 调度规则摘要
候选：owner 作者、非 `[Owner]`/epic、无排除标签、无 `rt/<n>-*` 的开放 PR（除非 ask 恢复）、未终态、依赖满足（依赖已 CLOSED，或恰好 1 个 `rt:ready-to-merge` 依赖 PR → 以其分支为 base 堆叠；多于 1 个则等待）。同系列（首个 `[..]` 前缀）与有依赖关系的 issue 互斥。排序：bug → priority → `rt:self` → 创建时间。`--dry-run` 只打印 `DRY would claim` / `DRY skip #n: 原因`。

## 状态文件
`status.tsv`（n state wake updated detail，与旧格式相同，`state/status.lock` 共享 flock）、`state/heartbeat`、`logs/sched.log`、`logs/work/<n>-<ts>.log`、`logs/gates/`、`logs/decide/`、`logs/chief/`、`locks/<n>.lock|.info`、`state/base/<n>`、`state/children/<n>`、`state/issues/<n>.json`、`state/merges.log`、`state/main_red`、`state/reverted/`。

## 已知限制
见交付报告：Gate 0 隐私扫描只对 `test/` 下文件豁免通用密钥形状（`bin/rt-gate0` 的 `SECRET_SHAPE_KINDS` 所列类别），其他路径（如 `scripts/validate-site.mjs`）里的同类字符串仍会报警且不可被决策者覆盖；真实 pi/codex/Opus 链路只做了假 gh/pi/codex 的桩测试（见 `test/run-all.sh`）。
