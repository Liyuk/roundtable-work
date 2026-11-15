# Case: Four Days of the roundtable-work Self-Loop (2026-11-11 to 2026-11-14)

A field record of this repository developing itself with the host-side self-loop (scheduler plus per-issue workers). It is anonymized: machine, path, account and personal details are generalized. All times are PST. Snapshot: 2026-11-14 21:55 PST.

Follow-up work derived from this case is tracked in [#330](https://github.com/Liyuk/roundtable-work/issues/330) ([RT-O]).

## Key findings

1. **Small issues already complete on their own.** Of the 36 sub-issues created by decomposition, 33 merged on their first dispatch. Before it was split, the large issue [#28](https://github.com/Liyuk/roundtable-work/issues/28) took 19 dispatches, 21 wakes and 9 fix rounds.
2. **The biggest losses were on the host, not the models.**
   - Across 11-13 and 11-14, whole-host freezes logged by the supervisor's checks totalled about 15 hours, and the scheduler hung once for about 4 hours.
   - A model usage limit left the scheduler idle for 7.3 hours.
   - A `series_key` bug kept average parallelism at 2 of 8 slots.
3. **Unsupervised self-decision is only partly achieved.**
   - Owner comments pulled issues back 27 times, falling from 17 a day on 11-12 to 1 on 11-14.
   - Host patches came in 36 classes, all applied by hand by the supervisor; the loop cannot yet repair itself.

## Data scope

| Item | Value |
| --- | --- |
| Repository | 197 issues (25 open), 110 PRs (107 merged, 3 closed) |
| Scheduler log | `<host>/rt-loop/logs/sched.log`, 817 lines, 11-11 14:48 to 11-14 21:53 PST |
| Worker log | `logs/workers.log` (2011 lines); `logs/chief/` holds 249 wake logs, 93 of them codex jsonl |
| Host patches | 94 `*.bak-*` backups in 36 tag classes; `rt-work.sh` went through 17 versions |
| Core 11 items | #97 #52 #26 #27 #29 #30 #31 #33 #32 #34 #46; the last, #46, closed 11-14 19:58 PST |

Merged PRs per day (PST): 11-10: 4 · 11-11: 10 · 11-12: 38 · 11-13: 32 · 11-14: 23. The scheduler took over on 11-12, and throughput rose from then on.

## 1. How far self-loop, self-iteration and "wish-style" programming got

| Goal | Status | Evidence |
| --- | --- | --- |
| Self-loop | Mostly achieved | The scheduler ran for 4 days with 188 dispatches; 99 ended `done` and 107 PRs merged. It was restarted 16 times, and a stall guard (waitguard) was added later. |
| Drop an issue in; it is claimed and finished | Achieved for small issues | 33 of 36 sub-issues finished in one dispatch, and 27 needed a single wake. Large issues were decomposed automatically 13 times. |
| Unsupervised self-decision | Partial | The decider resolved on its own 18 stops, 17 gate disagreements, 11 safety-file merges and 7 asks. Host faults still needed a human, and the decomposition of #196 had to be finished by hand. |
| Self-iteration (the loop repairs itself) | Rules written, not yet in effect | Stall detection (#218) and the host-rule ports (#287, #288) are merged, but the host scripts are still the only running implementation; the cutover to `runtime/` (#290) is not finished. |

Wish-style example: #55, #63 and #64 were large requests dropped in on 11-11. On 11-14 21:52 PST they were claimed together and decomposed within a minute into #302–#312, then executed with no one watching:

```text
11-14 21:52 PST worker #63 exited rc=0 state=held decomposed into 302 303 304 305 306
11-14 21:52 PST worker #64 exited rc=0 state=held decomposed into 307 308 309
11-14 21:53 PST worker #55 exited rc=0 state=held decomposed into 310 311 312
```

### Human interventions: counts and reasons

| Type | Count | Reasons and evidence |
| --- | --- | --- |
| Owner comment pulled an issue back | 27 | 17 issues: #28 5 times, #49 and #77 3 each, #97 and #111 2 each. Log line: `owner comment newer than terminal status, re-opening`. |
| Host patches | 36 classes | For example codex 12, lenient 9, ac 9, routing 7, escalate 7, plus utf8, series, waitguard, subretry, budget. All applied by hand by the supervisor. |
| Scheduler restarts | 16 | Includes 5 STOP-file stops. The one at 11-14 19:55 PST was caused by a scheduler hang. |
| Loop asked the owner | 4 | #28: main history was rewritten (destructive); #77: one scope question, one credentials question; #81: whether a native dependency may be installed (credentials). |
| Issues created by hand | 2 | Drafts 05 and 06 of the #196 decomposition failed to create; #265 and #267 were created by hand afterwards. |
| Noise issues bulk-closed | 38 | Of 54 auto-filed Gate 2 follow-ups, 38 were closed at once on 11-12 22:24–22:26 PST. |
| Owner-only issues | 6 | #36–#40 are manual steps such as branch protection, go-live and splitting credentials; #81 was p0. |

Owner pull-backs per day (PST): 11-11: 6 · 11-12: 17 · 11-13: 3 · 11-14: 1. The 11-12 peak came from large security issues such as #28 and #49 failing their gates again and again. After decomposition (#97, merged 11-12 22:13) and the lenient review rules arrived, pull-backs dropped sharply.

## 2. How very large requests were decomposed

| Parent | Split at (PST) | Children | Outcome |
| --- | --- | --- | --- |
| #26 RT-1 | 11-11 15:55 | #49–#53 | #52 was split again into #96–#98 (two levels). #26 closed 11-13 12:15 |
| #28 RT-3 | 11-12 12:36 | #101–#103 | 21 wakes before the split; closed about 23 h after it |
| #220 RT-U | 11-13 18:04 | #231–#236 | All closed in about 7 h, but the cutover was not done, and #264 redid the scope |
| #27 RT-2 | 11-13 12:16 | #222–#225 | Closed in 5.5 h |
| #32 RT-3b | 11-13 18:32 | #242–#244 | Closed in 4.5 h |
| #33 RT-S | 11-13 23:06 | #249–#253 | Closed in 1.8 h |
| #196 RT-F | 11-14 01:06 | #260–#263, plus #265 and #267 created by hand | Draft 05 failed to create, and the next 3 wakes were wasted; #196 waits on #264 |
| #260 RT-F-1 | 11-14 03:05 | #266, #268, #269 | Second-level split; the three children ran one after another, 4.2 h |
| #34 RT-7 | 11-14 03:52 | #270–#274 | The children ran serially for 8.2 h; #34 was verified and closed at 14:00 with no PR needed |
| #264 RT-U2 | 11-14 09:50 | #285–#290 | #285–#288 merged, #289 running, #290 queued |

Wakes before and after splitting: #28 (before) took 21 wakes and 9 fix rounds; #49 (before) 12 wakes and 6 fix rounds. The worst child, #235, took 5 wakes and 1 fix round; the median child took 1 wake.

What worked:

- High first-pass rate (33/36). Every child carries acceptance criteria and a `Parent` field. The parent waits under `rt:hold` and is released automatically once all children close (`all sub-issues closed … releasing rt:hold`).
- Two levels when needed: #26 → #52 → #96–#98, and #196 → #260 → #266/#268/#269.

What did not:

- **Decomposition came too late.** #28 spent about 24 hours and 9 fix rounds before it was split. #28 and #49 also made 6 top-tier model calls (2 and 4) on the evening of 11-11, before the rule against that tier existed.
- **Sibling dependencies were lost.** Drafts referencing not-yet-created `sub:02` / `sub:03` had the reference dropped: 3 `reference dropped` lines (#64, 11-14 21:52).
- **Series exclusion serialized unrelated siblings.** [RT-7a]…[RT-7e] all mapped to `RT-7`, so five children ran one after another for 8.2 h; RT-U2a–f did the same. By title, the RT-7 children are unrelated modules: systemd templates, a release script, temporary load, risk labels and an operator guide.
- **Scope was duplicated.** The children of #220 (RT-U) ported rules, state-as-truth and shadow mode but never cut over; #264 (RT-U2) then opened #287–#290 for largely the same work.
- **Creation failures were not retried.** Draft 05 of #196 failed during a host freeze. The Chief then woke 3 more times for nothing (01:06–02:30 PST) and stopped; the supervisor later added a retry patch (subretry).

## 3. Redundancy, dead loops and token waste

| Source | Quantity | Evidence |
| --- | --- | --- |
| Whole-host freezes | About 8.7 h on 11-13 (7 windows), about 6.7 h on 11-14 (5 windows) | Supervisor checks, matching the silent windows in the logs (e.g. 11-13 01:54–03:52 and 19:57–21:49). 11-14 21:51: `WARN scheduler cycle gap 6883s` |
| Scheduler hang | About 4 h | No new line in either log after 11-14 15:53 PST until the 19:55 restart; waitguard added afterwards |
| Idle during a model usage limit | 92 cycles, 7.3 h | 11-12 02:30–09:51 PST, one `model usage limit … no sweeps, claims or resumes` line every 5 min |
| Repeated re-dispatch during the limit | 8 | #28 and #50 were re-dispatched every 30 min (11-12 06:46, 07:18, 07:49, 08:20 PST), hitting the limit again each time |
| Provider budget exhausted (HTTP 402) | #235 stalled about 1 h | 11-13 23:01 PST: two wakes with rc=1 and no progress. The limit classifier did not recognize `budget_exhausted` (patch below) |
| Rework after gate failures | 51 fail verdicts, 38 fix rounds | #28 9 rounds, #49 6; #50, #81, #101 and #191 2 each |
| Wakes with no outcome | 10 wakes without a decision, 14 `no valid DECISION`, 14 reviewer runs without a verdict | worker log |
| Model routing conflict caused stops | 6 | 11-12 13:11–22:22 PST: the reviewer route for #97, #101, #108, #110, #111 and #170 resolved to a forbidden model; fixed later by the routing patch |
| main red after auto-merge | 4 reverts, 4 red-main issues | PRs #154, #169, #203, #293; claims paused for 29 cycles, 11-12 15:13–17:10 PST |
| Gate 2 follow-up noise | 54 filed, 38 bulk-closed, 7 merged | e.g. #67: "not high risk; recorded, not handled separately" |
| `series_key` bug | Average parallelism 2.02 (cap 8) | 11-12 22:27 to 11-14 03:50 PST; 3.54 after the fix |

Time-weighted average of concurrent workers, computed from `spawned` / `exited` events:

| Window (PST) | Average concurrency |
| --- | --- |
| 11-11 14:48 – 11-12 22:27 (2 to 4 slots) | 1.14 |
| 11-12 22:27 – 11-14 03:50 (8 slots, series bug) | 2.02 |
| 11-14 03:50 – 19:55 (after the fix) | 3.54 |

Tokens: the 93 codex Chief wake logs contain 85 `turn.completed` events, totalling 414.7M input tokens (404.4M of them cache hits, 97.5%) and 2.0M output tokens. #81 (a `/proc` path problem on macOS) alone used 92.5M input tokens (22%) and still ended as an ask (credentials) to the owner. pi and haiku wakes recorded no usage, so they could not be counted.

Two host patches, for reference:

```diff
# bin/rt-limit: treat HTTP 402 as a quota wait
- PAT = re.compile(r"usage limit|rate[ -]?limit(ed)?|...|insufficient_quota|try again at", re.I)
+ PAT = re.compile(r"usage limit|rate[ -]?limit(ed)?|...|insufficient_quota|budget[ _]exhausted|try again at", re.I)

# rt-sched.py: series key
- tok = re.split(r"[\s\-/:]+", ...)[0]        # [RT-3b] -> RT, every RT issue in one series
+ tok = re.split(r"[\s/:]+", ...)[0]; tok = re.sub(r"(\d)[a-z]$", r"\1", tok)   # [RT-3b] -> RT-3
```

## 4. Improvements, ranked by benefit

1. **Fix host freezes first.** The host showed memory pressure; cap worker memory, or lower parallelism until freezes stop. About 15 hours of freezes plus a 4-hour hang over two days is the largest single loss.
2. **Use touch sets instead of series for mutual exclusion** ([#310](https://github.com/Liyuk/roundtable-work/issues/310)). Siblings such as RT-7 and RT-U2 that touch different files can run in parallel, saving hours per chain.
3. **Estimate size at claim time.** Decompose anything over about 400 lines, or carrying a security threat model, before implementing it. Rework like the 9 and 6 rounds on #28 and #49 costs the most tokens.
4. **Stop completely during a usage limit.** Wake on a timer at the unblock time ([#309](https://github.com/Liyuk/roundtable-work/issues/309)) instead of re-dispatching every 30 minutes into the same wall.
5. **Keep sibling dependencies when decomposing.** Create every child first, then back-fill the `sub:NN` references, instead of dropping them.
6. **Tighten Gate 2 follow-ups.** Open issues only for high/critical findings and put the rest in a PR comment, to avoid another 54-opened, 38-closed flood.
7. **Let the loop repair the host.** Turn the faults behind the 36 host patch classes into rules (#287/#288 ported 10), and finish the #290 cutover, so `runtime/` is the only implementation and the supervisor only approves.
8. **Check for duplicates before opening work.** Before #264, check what #220 actually delivered.

## Evidence and gaps

- [#28](https://github.com/Liyuk/roundtable-work/issues/28): 21 wakes, finally split into #101–#103
- [#196](https://github.com/Liyuk/roundtable-work/issues/196): child creation failed; #265 and #267 created by hand
- [#220](https://github.com/Liyuk/roundtable-work/issues/220) and [#264](https://github.com/Liyuk/roundtable-work/issues/264): duplicated scope
- [#34](https://github.com/Liyuk/roundtable-work/issues/34): five children ran serially for 8.2 h
- [#81](https://github.com/Liyuk/roundtable-work/issues/81): one issue used 92.5M input tokens
- [PR #169](https://github.com/Liyuk/roundtable-work/pull/169): main red after auto-merge, reverted
- [#67](https://github.com/Liyuk/roundtable-work/issues/67): an example of a bulk-closed Gate 2 follow-up

Caveats:

- Freeze windows come from the supervisor's observations, cross-checked against silent windows in the logs. The host has no direct tool to prove a kernel freeze, so the durations are estimates.
- Tokens cover only codex Chief wakes. pi, haiku and deepseek delegation and review recorded no usage, so actual consumption is higher than 414.7M.
- Backup file times are the modification time of the replaced version, not exactly the patch time, so only patch classes and counts are reported.
- The earlier `rt-loop.sh` phase, before 11-11 14:48 PST (`logs/loop.log`, 58 lines), is not included in the scheduler statistics.
