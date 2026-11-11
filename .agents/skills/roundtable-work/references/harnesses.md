# Harness Capabilities Mapping

Before starting, fill in the table below by comparing with the **actual tools available in the current session**. The tool names listed are commonly observed in 2026-11 and may not exist if the version, configuration, or product form differs. If a tool is not found, treat it as “不支持” (unsupported).

| Capability | Purpose | Claude Code (Common) | Codex (Common) |
| --- | --- | --- | --- |
| Create sub-session | Delegate execution and independent review | `Agent` (or `Task`) tool; `subagent_type` can optionally select `rt-developer`, `rt-reviewer`, `rt-fixer`, `rt-researcher` from `.claude/agents/` | In-session collaboration tools like `spawn_agent`; or use `codex exec` to start non-interactive execution |
| Receipt Granularity | Record delegation events | Usually only “已启动 / 已完成” (started / completed) | Depends on tool |
| Send follow-up to existing sub-session | Fixes, target revisions | `SendMessage` (if available) | Tools like `followup_task` |
| Wait for Results | Collect delivery cards | Foreground calls return directly; when running in background (`run_in_background`), sub-agent completion acts as a notification to start Chief's new turn (tested on Claude Code desktop on 2026-11-10, limited to same application session) | Tools like `wait_agent` |
| Wake up after turn ends | Continue without external prompting | Scheduled tasks or timer tools (e.g., `CronCreate`, `/loop`, desktop scheduled tasks), only available if actually present in session | Not verified |
| Skill Discovery | Load this skill | `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/` | `.agents/skills/<name>/SKILL.md` |

When the harness has both "application-level sessions" (visible to user, another independently running session) and "in-process sub-agents", delegation cards are delivered to sub-agents by default; application-level sessions are used only for user-requested, independently scoped tasks.

## Recording Method

Write one line of capability conclusion in the continuation record or ticket from the first turn, for example:

```text
宿主：Claude Code · 子 session：支持（Agent）· 后续消息：支持（SendMessage）· 回合后唤醒：不支持 · 证据：本会话工具列表
```

For capabilities not personally invoked, write “列出但未验证” (listed but not verified). Do not write “支持” (supported) just because documentation or this table mentions a tool.

## Strategies Under Different Capabilities

- **Can create sub-session and collect results**: Author and reviewer use different sub-sessions; Chief only reads delivery cards and necessary evidence.
- **Sub-agent's working directory differs from workspace** (session opened in different repo): Write absolute paths on the card; harness's isolated working tree usually only applies to the session's own repository and cannot substitute for workspace isolation.
- **Sub-sessions cannot communicate directly**: All communication goes through Chief: `作者 → Chief → 审查者 → Chief → 作者` (author → Chief → reviewer → Chief → author).
- **Can only wait in foreground**: Chief waits and continues within this turn; inform user that session will not automatically continue after turn ends.
- **No delegation capability**: Single session executes sequentially, review marked as “自查，非独立审查” (self-review, not independent review).
- **Has post-turn wake-up capability**: Only set wake-up for registered wait conditions, stating purpose, interval, validity period and stop conditions; do not create timer tasks without authorization.
