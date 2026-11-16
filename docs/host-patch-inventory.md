# Host patch inventory

Versioned inventory of the host patch tag classes (issue #334, input to #290). Each row gives the
behavior in one line, then one of:

- `runtime/<file>` + `test/<file>` :: test name — the rule is ported and this test covers it;
- `not ported: <reason> #<n>` — the rule has no runtime counterpart yet; the row names its tracking issue;
- `not needed after cutover: <reason>` — the rule has no runtime counterpart and none is needed after cutover;
- `superseded by <rule/issue>` — the rule is replaced by a newer single source.

`test/runtime/host-patch-inventory.test.mjs` parses this table and fails on a row without a
reference or reason, on a `not ported:` row that names no issue, a missing referenced file, or a test name that does not exist.

| Tag class | Behavior | Mapping |
|---|---|---|
| codex | Model routing was pinned per harness and tag class. | superseded by config.env single routing source (#303) |
| escalate | A disputed decision escalates to a route, and a persisted attempt is retried on a later run. | `runtime/lib/decisions.mjs` + `test/runtime/escalation.test.mjs` :: daemon retries a persisted disputed decision on a later invocation |
| limit | During a usage-limit wait the loop waits and then probes again. | `runtime/lib/fallback.mjs` + `test/runtime/fallback.test.mjs` :: a 402 on the primary model re-runs once on the fallback, then returns to primary after the TTL |
| limitmain | Main health and revert checks keep running during a usage-limit wait. | `runtime/lib/fallback.mjs` + `test/runtime/fallback.test.mjs` :: usage-limit wait still checks main CI once when the limit has already passed |
| budget | Budget exhaustion (budget_exhausted, 402) counts as a quota limit, not a block. | superseded by #288 rule 10 |
| nofunds | A balance error (402) on the primary model switches to the fallback model. | superseded by config.env single routing source (#303) |
| routing | Each work type routes through one configured model; unknown or malformed routes are rejected. | `runtime/lib/routing.mjs` + `test/runtime/routing.test.mjs` :: routes each work type through its configured model |
| allpi | Routing preset that sent every role to the pi harness. | superseded by config.env single routing source (#303) |
| luna | Routing preset for the luna model family. | superseded by config.env single routing source (#303) |
| w6 | Routing preset for the w6 model family. | superseded by config.env single routing source (#303) |
| migrate | One-off routing migration preset. | superseded by config.env single routing source (#303) |
| author | Commit author identity for merges. | not needed after cutover: the runtime does not set a commit author; commit metadata is only screened for host identifiers |
| ac | Delivered diffs stay inside the acceptance scope; an out-of-scope path is rejected. | `runtime/lib/accept.mjs` + `test/runtime/accept.test.mjs` :: an out-of-scope path rejects without running tests |
| gate | Gates run in order; a failed gate blocks later gates and the merge. | `runtime/lib/gates.mjs` + `test/runtime/gates.test.mjs` :: gate failure blocks subsequent gates and merge |
| lenient | A thin Gate 1 rationale requires a Gate 2 cross-check. | `runtime/lib/gate2-triggers.mjs` + `test/runtime/gates.test.mjs` :: Gate 1 with an empty or thin rationale requires Gate 2 |
| review / reviewer | An unavailable reviewer is retried once; then only ready-to-merge is labeled. | `runtime/lib/gates.mjs` + `test/runtime/gates.test.mjs` :: reviewer unavailable is retried once, then only ready-to-merge is labeled |
| skills | Skill selection for delegated work. | not ported: skill selection is an agent-side workflow with no runtime counterpart; tracked by #428 |
| followup | Follow-up items are queued after a ticket. | not ported: the scheduler rule (rt-sched/rt-work) is not in this repository; tracked by #428 |
| blockedrtm | Scheduler rule for blocked RTM items. | not ported: the scheduler rule (rt-sched) is not in this repository; tracked by #428 |
| series | Series key is the full tag minus its trailing letter; the series is waited on as a unit. | not ported: pending #310 |
| utf8 | State readers decode with replacement and never throw on a truncated multi-byte sequence (covered by test/runtime/state.test.mjs and test/runtime/status.test.mjs); writers that truncate text cut on a code-point boundary. | `runtime/lib/ci-classifier.mjs` + `test/runtime/ci-classifier.test.mjs` :: truncation cuts on a code-point boundary, not inside a surrogate pair |
| waitguard | Bounded wait with a cycle-gap WARN. | not ported: pending #333 [RT-O-3] |
| tmpclean | Prune leaked test temp and lock directories. | `runtime/lib/prune.mjs` + `test/runtime/prune.test.mjs` :: RT-S6 prune removes only old, owned rt temp entries with no live pid and keeps the rest |
| cirerun | Re-run only cancelled required CI, then hold. | `runtime/lib/gates.mjs` + `test/runtime/gates.test.mjs` :: cancelled-only required CI requests one re-run and holds instead of failing into the fixer path |
| mainrerun | Main-red CI re-run goes through the real gh; success is logged only when the re-run is accepted. | `host/rt-sched.py` + `host/test/mainrerun.test.mjs` :: main-red re-run uses the real gh and logs WARN with no success line when the re-run fails (#539) |
| ciwait | Only pending required CI is a resumable hold; every other not-green answer fails closed. | `runtime/lib/gates.mjs` + `test/runtime/gates.test.mjs` :: only pending required CI is a resumable hold; every other not-green answer fails closed before squash |
| mergelock | Only one holder at a time may own the merge lock. | `runtime/lib/lock.mjs` + `test/runtime/lock.test.mjs` :: lock: stale takeover is mutually exclusive across real processes: one winner per round, never two holders |
| nopr-close | Close an issue that has no pull request. | not ported: no close-without-PR path in the runtime (parent-close covers decomposition parents only); tracked by #428 |
| recordretry | Read-back retry for a safety record. | `runtime/lib/gates.mjs` + `test/runtime/gates.test.mjs` :: a missed recorded-approval read is retried and then succeeds without becoming a rejection |
| safetyfmt | Format of the safety record. | not ported: the rule lives in the rt-work script, which is not in this repository; tracked by #428 |
| subretry | Sub-issue create retry with a duplicate check. | not ported: pending #332 [RT-O-2] |
| syncbudget | Budget sync rule. | not ported: the rule lives in the rt-work script, which is not in this repository; tracked by #428 |
| trim | Trimming of queue.txt. | not ported: queue.txt trimming is a scheduler rule; the runtime reads the queue through queue.mjs only; tracked by #428 |
| dated snapshots 20261112/20261113 | Dated copies of prompt, policy, and config files. | not ported: dated snapshot files are agent-side artifacts with no runtime counterpart; tracked by #428 |
