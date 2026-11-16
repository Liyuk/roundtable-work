# Roundtable autonomy benchmark

Status: baseline measured 2026-11-16 19:36 UTC (measurement time `T`). Parent: #414 [RT-S]. Scope: foundation only. Harness, account and quota switching, mobile control and board #439 are out of scope.

## 1. Purpose and how to use it

The owner's goal is level 5 on all four dimensions. At level 5, roundtable:

- runs **unsupervised (U)**;
- **self-loops (L)**: it sources its own work;
- **self-iterates (I)**: it improves its own process and measures the result;
- **self-decides (D)**.

It does all of this with no external assistant. The #414 exit criterion is a 72 h window with:

- zero counted interventions;
- at least 6 PRs merged by the loop;
- at least 1 self-sourced issue merged;
- no unrecovered freeze;
- a `self` ledger entry in every 24 h slice.

This document defines how each dimension is measured, so that `rt-bench` can compute every number from records.

Rules of use:

1. **Every improvement issue names its target.** The body carries one line: `Bench: <ID> <current value> -> <expected value> (level a -> b) within <days> d`. Example: `Bench: U3 21 -> 0 (level 0 -> 5) within 7 d`. A self-sourced issue without this line is not `rt:go`. The owner may waive the line explicitly.
2. **Every improvement is checked after it merges.** Seven days after the merge, `rt-bench` compares the value with the expected delta and records the outcome (see I4).
3. **Thresholds change only through the owner.** The thresholds, the windows and `rt-bench` itself are safety files. Changing them follows the owner-approval path.

## 2. Measurement window and conventions

- **Window `W`.** The rolling 7 days ending at `T`, unless a metric says otherwise. `W` is clipped to the start of production operation: 2026-11-11 08:00 UTC, the first day with a ledger row. That leaves 131.6 h in the current `W`. `W72` means `[T-72 h, T]`.
- **Time zone.** Everything is computed in UTC, and daily slices are `(T-24(k+1) h, T-24k h]`. Inputs are converted as follows:
  - interventions.tsv timestamps are US Pacific (America/Los_Angeles; UTC-8 in November);
  - merges.log is marked CST (UTC+8);
  - sched.log lines carry their own zone marker;
  - daily.jsonl rows are Pacific calendar days, and values taken from it are labelled as such.
- **Date-only ledger rows** (rows 1–48) are anchored at 23:59:59 Pacific on their date, following the rt-metrics convention. They are never used to create a gap that was not measured.
- **Counted intervention.**
  - It is an action by the owner or the external assistant (`source` ∈ {owner, external}) whose category is not `owner-only`.
  - It includes hand patches, restarts, cap or config changes, label changes, answers, merges, closes, CI re-runs, issue filing and acceptance edits.
  - Standing rows marked `continuous` (patrol, freeze watching) are not counted as events. While one is active, U1 and U2 are capped at level 2.
  - **Unrecorded actions still count once `rt-bench` finds them** by reconciliation. These are: a human merge missing from the merge ledger; a backup or patch tag with no ledger row; an owner-account comment with no loop marker; a live scheduler start not made by the unit or watchdog.
- **Intervention episode (MTBI only).** Counted entries are sorted by time and grouped greedily. An entry within 30 min of the previous one joins its episode. Each date-only row is its own episode. Every other metric uses raw counts.
- **Freeze time.** It is excluded only when the freeze ledger classifies it as `host-freeze`: wall-clock time advanced and monotonic time did not. `scheduler-stall` is never excluded. The host loop has no freeze ledger today, so `F(W) = 0`. The unclassified cycle gaps are reported for information only: 29 gaps, 27.2 h.
- **Owner-only actions** come from the closed list in docs/self-supervision.md. They are excluded, but capped. Beyond 2 entries per `W`, or beyond 20% of all owner and external entries, the excess counts.
- **Paused time.** It is excluded only between ledger `pause` and `resume` entries, capped at 24 h per `W`.
- **Not measurable means level 0.** A missing source, or one staler than 24 h, makes the sub-metric "not measurable" at level 0. A gap in the data is never scored as a zero value.
- **Reverts subtract.** A merged `Revert` PR removes the reverted merge from every merge count, and is itself not counted as work.

## 3. Unsupervised (U)

- **U1 MTBI.** `MTBI = (|W| − F(W) − P(W)) / E(W)`, where `E(W)` is the number of counted intervention episodes. If `E = 0`, the value is the lower bound `|W| − F − P`.
  - Source: host loop state, interventions.tsv; later `.roundtable/state/interventions.jsonl` plus the freeze ledger.
  - Current: 74 counted rows give 59 episodes (48 date-only rows plus 11 clusters among 26 timestamped rows). `131.6 h / 59 = `**2.2 h**.
  - The row-based figure is 1.8 h.
  - The figure is an upper bound. It leaves out owner-account GitHub comments that rt-metrics flags (15 supervisor-signed comments on 11-15, and 190 unsigned owner-account comments on 11-11..11-15). Counting them would lower it.
  - Since 11-15 00:00 PST (35.6 h, 12 episodes) it is 3.0 h.
- **U2 Longest unsupervised streak.** The maximum time between consecutive counted intervention instants in `W`, including `[t_last, T]`, minus the freeze time inside it.
  - Source: interventions.tsv.
  - Current: **9.9 h**, from row 47 (anchored 11-15 23:59:59 PST) to 11-16 09:55 PST. The two timestamped rows bounding it are 13.3 h apart. The current streak is 0.2 h.
- **U3 Manual scheduler starts.** The number of live scheduler starts in `W` not made by the process unit or the watchdog.
  - Source: sched.log `rt-sched start … dry=False once=False` lines, minus the first start. No process supervisor exists, so every later start is manual.
  - Current: **21** (8 in `W72`).
- **U4 Freeze self-recovery.** Of the scheduler interruptions in `W` (cycle gaps longer than 3× poll), the share followed by neither a manual start nor a counted intervention within 60 min of resuming.
  - Source: sched.log `WARN scheduler cycle gap` lines, start lines, and interventions.tsv.
  - Current: 29 gaps, all logged from 11-15 05:51 UTC onward. 11 were followed by a human action within 60 min, so the share is **18/29 = 62%**.
  - This is a proxy: it measures timing, not cause. It needs a new event, `freeze` (see section 9).
- **U5 In-flight work lost.** The number of worker stages in `W` that ended on a wall-clock timeout (`rc=124`) or by a signal without a final state (`rc=-15`).
  - Source: workers.log and sched.log.
  - Current: **5** (3 timeouts, for #28, #53 and #98; 2 signal kills, for #61 and #177). All of them happened on 11-12 or 11-13.
- **U6 Self-ledger coverage.** The number of 24 h slices in `W` that contain at least one `self` ledger entry (#414 exit condition 5).
  - Needs a new event: `self` ledger entries (section 9).
  - Current: **not measurable**. The host loop writes no `self` entries.

| ID | L0 | L1 | L2 | L3 | L4 | L5 | Current | Level |
|---|---|---|---|---|---|---|---|---|
| U1 MTBI h | <2 | ≥2 | ≥6 | ≥12 | ≥24 | ≥72 | 2.2 | 1 |
| U2 streak h | <6 | ≥6 | ≥12 | ≥24 | ≥48 | ≥72 | 9.9 | 1 |
| U3 manual starts | >14 | ≤14 | ≤7 | ≤3 | ≤1 | 0 | 21 | 0 |
| U4 self-recovery | <50% | ≥50% | ≥70% | ≥85% | ≥95% | 100%, n≥5 | 62% | 1 |
| U5 lost stages | >12 | ≤12 | ≤6 | ≤3 | ≤1 | 0 | 5 | 2 |
| U6 slices with self | 0 | 1–2 | 3–4 | 5 | 6 | 7/7 | n/m | 0 |

## 4. Self-loop (L)

A **self-originated** issue was created by the loop from its own evidence: a gate finding, a failure signature, a metric breach, or self-review. Sub-issues created by decomposing an owner or assistant issue are labelled `rt:self` but are **not** self-originated. Today, the only self-originated issues are `Gate 2 follow-up …` issues: 54 of them, all filed on 11-12.

- **L1 Days with self-originated work merged.** The number of 24 h slices in `W` containing at least one merged, non-reverted PR that closes a self-originated issue.
  - Source: GitHub issues (`rt:self`, title or origin) joined with merges.log.
  - Current: **2/7**, on the slices ending 11-12 19:36 and 11-13 19:36 UTC. The last such merge was at 11-13 15:45 UTC, so `W72` has 0.
- **L2 Self-sourced acceptance.** `|self-originated issues closed in W by a merged, non-reverted PR| / |self-originated issues closed in W|`.
  - Current: (15 merged − 2 reverted, #169 and #203) / 54 = **24%**.
  - The rest: 38 issues were closed as not planned, and #89 was closed as completed without a PR, which does not count as merged work.
- **L3 Self-originated share of merged work.** `|non-revert loop merges in W whose issue is self-originated, net of reverts| / |non-revert loop merges in W|`.
  - Current: 13/184 = **7.1%**.
- **L4 Externally filed issues per day.** `|issues created in W without rt:self or rt:followup| / 7`.
  - Source: GitHub. All issues share one account, so the label is the only discriminator.
  - Current: 145/7 = **20.7/day**.
- **L5 Idle time.** The hours in `W` during which the scheduler was live and not frozen, zero workers were running, there was no quota wait, and the queue had no claimable issue.
  - Needs a new event: `queue-snapshot`.
  - Current proxy: zero-worker hours outside usage-limit waits, from sched.log spawn and exit lines, = **7.5 h**. This is an upper bound: it includes dependency waits and main-red holds.

| ID | L0 | L1 | L2 | L3 | L4 | L5 | Current | Level |
|---|---|---|---|---|---|---|---|---|
| L1 days/7 | 0 | 1 | 2–3 | 4–5 | 6 | 7 | 2 | 2 |
| L2 acceptance | <20% | ≥20% | ≥40% | ≥55% | ≥70% | ≥80% | 24% | 1 |
| L3 share | 0 | >0 | ≥8% | ≥15% | ≥25% | ≥40% | 7.1% | 1 |
| L4 external/day | >12 | ≤12 | ≤6 | ≤3 | ≤1 | ≤0.43 (≤3/wk) | 20.7 | 0 |
| L5 idle h | >24 | ≤24 | ≤12 | ≤6 | ≤3 | ≤1 | 7.5 (proxy) | 2 |

## 5. Self-iteration (I)

A **runtime change** is any change to the code, prompts, policy or config that the running loop executes.

- **I1 PR-shipped runtime changes.** `|runtime changes in W deployed from a merged PR| / |all runtime changes in W|`.
  - Needs new events: `deploy` and `host-patch`.
  - Current: **0%**. The host loop is not in the repository (#520), so all 42 changes in `W` were hand patches.
- **I2 Hand patches.** The number of distinct hand-patch tags applied to the running loop in `W`.
  - Source: backup-file tags in the host loop directory, reconciled against the ledger's self-repair and host-patch rows.
  - Current: **42** tags. At least one tag, dated after the last ledger row, has no ledger row.
- **I3 Repeat-failure closure.** Among failure signatures that occurred at least 3 times in `W`, the share for which the loop itself filed or updated an issue within 24 h of the third occurrence.
  - Source: sched.log and workers.log, plus GitHub. A new `failure` event is needed for exact signatures.
  - Current: **0/7**. The 7 signatures:

    | Signature | Occurrences |
    |---|---|
    | main-red hold | 8 |
    | github read failure | 7 |
    | blocked, gates still failing | 7 |
    | blocked, no progress | 5 |
    | gate1-unavailable hold | 4 |
    | sync conflict | 3 |
    | merge refused on gates | 3 |

    The issues that were filed for these (#442, #493) came from the assistant.
- **I4 Measured changes.** `|process-change PRs merged in W with a pre-registered metric, baseline and expected delta, evaluated after 7 d| / |process-change PRs merged in W|`.
  - Needs new events: `change-eval` and `usage` (tokens per merged PR is null today).
  - Current: **not measurable**.
- **I5 Quality guardrail: first-pass rate.** `|merged PRs with gate evidence and no gate failure or rework| / |merged PRs with gate evidence|`. Once the ledger exists, PRs with a counted intervention on their line are also excluded.
  - Source: daily.jsonl `first_pass_n` and `rework_n`.
  - Current: 186/188 = **0.989**, over Pacific days 11-11..11-15 (11-16 is not yet in daily.jsonl). 13 PRs had no gate evidence.

| ID | L0 | L1 | L2 | L3 | L4 | L5 | Current | Level |
|---|---|---|---|---|---|---|---|---|
| I1 PR-shipped | <20% | ≥20% | ≥50% | ≥80% | ≥95% | 100%, ≥1 change | 0% | 0 |
| I2 hand patches | >12 | ≤12 | ≤6 | ≤3 | ≤1 | 0 | 42 | 0 |
| I3 closure | <20% | ≥20% | ≥40% | ≥60% | ≥80% | 100% | 0% | 0 |
| I4 measured | <20% | ≥20% | ≥40% | ≥60% | ≥80% | 100%, ≥1 kept gain/wk | n/m | 0 |
| I5 first-pass | <0.70 | ≥0.70 | ≥0.80 | ≥0.85 | ≥0.90 | ≥0.95, n≥20 | 0.989 | 5 |

## 6. Self-decision (D)

- **D1 Decision interventions.** The number of counted ledger entries in `W` with category `decision` or `decide`, or in which a human performed a terminal merge or close.
  - Current: **11**: rows 4, 31 and 37–40, plus 11-15 03:55 #391, 05:50 #428, 13:44 #340/#324/#309/#207, 11-16 09:55 #504 and 11:23 #520. Together they cover 16 issues.
- **D2 Longest owner wait.** The maximum duration in `W` that any line waited on an owner answer, excluding red-line asks. Waits counted: `rt:ask`, `rt:blocked`, verified-complete-awaiting-close, and decision holds. Open waits are measured to `T`.
  - Source: GitHub label events. A new `wait` event is needed for waits that carry no label.
  - Current: **13.6 h** (`rt:blocked`; the longest `rt:ask` was 3.6 h; none exceeded 24 h).
  - This is a lower bound: the waits on #504 and #207 carried no label.
- **D3 Self-settled decisions.** `resolved by the loop / (resolved + ask-owner + stop + invalid answers routed to the owner)`.
  - Source: decider logs and workers.log.
  - Current: 65 / (65 + 6 + 10 + 5) = **75.6%**.
- **D4 Rollback rate.** `|merged Revert PRs in W| / |non-revert loop merges in W|`. Any owner revert of a default decision also counts.
  - Current: 4/184 = **2.2%** (#169, #203, #293, #475).
- **D5 Loop-merged share.** `|loop merges in W| / |all non-bot merges in W|`.
  - Source: merges.log and GitHub.
  - Current: 188/200 = **94.0%**. The 12 human merges include #398 and #468.

| ID | L0 | L1 | L2 | L3 | L4 | L5 | Current | Level |
|---|---|---|---|---|---|---|---|---|
| D1 count | >12 | ≤12 | ≤6 | ≤3 | ≤1 | 0 | 11 | 1 |
| D2 max wait h | >96 | ≤96 | ≤48 | ≤24 | ≤12 | ≤4 (never blocks) | 13.6 | 3 |
| D3 self-settled | <60% | ≥60% | ≥80% | ≥90% | ≥95% | ≥98% | 75.6% | 1 |
| D4 rollback | >15% | ≤15% | ≤10% | ≤6% | ≤4% | ≤2%, n≥20 | 2.2% | 4 |
| D5 loop-merged | <70% | ≥70% | ≥85% | ≥93% | ≥97% | 100% | 94.0% | 3 |

## 7. Scoring

**Dimension score:** `min(floor(mean(levels)), min(levels) + 1)`. Level 5 additionally requires every sub-metric at 5.

- Why not a plain mean: strong sub-metrics such as I5 would hide a broken one such as I1.
- Why not a plain minimum: one noisy proxy would erase all credit for real progress.
- The cap at the weakest sub-metric plus one keeps each score honest about its weakest link.

**Overall score:** the minimum of the four dimension scores, because the owner's goal is the conjunction of all four.

| Dimension | Levels | Mean | Score |
|---|---|---|---|
| U | 1, 1, 0, 1, 2, 0 | 0.83 | **0** |
| L | 2, 1, 1, 0, 2 | 1.2 | **1** |
| I | 0, 0, 0, 0, 5 | 1.0 | **1** |
| D | 1, 3, 1, 4, 3 | 2.4 | **2** |
| Overall | | | **0** (profile U0 L1 I1 D2) |

**Comparison with the architecture review.** The review scored 2/2/1/2 from qualitative evidence. U drops to 0 here because manual restarts and the missing self ledger are now counted. The measured MTBI (2.2 h over 7 d, 3.0 h since 11-15) is below the review's 6–13 h estimate, which was based on gaps rather than counts.

**#414 exit snapshot for `W72`:**

| Condition | Result |
|---|---|
| Zero counted interventions | **fail** (≥26 timestamped rows) |
| At least 6 loop merges | pass (137) |
| At least 1 `source:self` merged | **fail** (0) |
| No unrecovered freeze | not measurable (no freeze ledger; 8 manual starts) |
| `self` entry every 24 h | **fail** (not recorded) |

## 8. Anti-gaming and regression rules

### Global rules

- `rt-bench` reads raw sources: GitHub, the logs and the ledgers. It does not read the loop's own summaries when a raw source exists.
- Re-categorising a ledger entry, for example to `owner-only`, does not remove it. The category at first write is the one that counts.
- Closing an issue without a merged PR or acceptance evidence never counts as completed work.
- Several PRs from one issue merged within 24 h count as one for L1, L3 and D5.

### U

- The episode clustering (30 min) is applied by `rt-bench` only. Recorders cannot batch rows.
- Freeze time is excluded only by the freeze ledger.
- A restart counts as `self` only when it is made by the unit or watchdog deployed from `main`.
- While any external patrol exists, U1 and U2 are capped at level 2.

### L

Self-originated issues must:

- link their evidence and carry a fingerprint;
- pass duplicate and overlap checks;
- not be trivial: at least 5 changed non-comment lines, or a docs change tied to a failure, plus a test or acceptance evidence.

In addition:

- Decomposition children never count as self-originated.
- Not-planned and duplicate closures lower L2.
- The cap is 3 self-sourced issues per day and 5 open.

### I

- A change counts as PR-shipped only if the deployed version contains it.
- Metrics must be registered in the issue before the PR opens. Choosing a metric after the fact counts as unmeasured.
- Patches without a ledger row count twice in I2: once as a patch and once as an unrecorded intervention.

### D

- Relabelling (`ask`→`blocked`→`hold`) does not reset the wait clock. The clock is keyed on issue plus question.
- Red-line exclusions are limited to the closed list and capped at 2 per `W`.
- A fail-closed fallback that parks a line counts as an owner wait.
- An owner reversal of a default decision counts in D1 and D4.

### Regression rule

`rt-bench` runs daily at 00:00 UTC and appends a snapshot.

**A regression is any of:**

- a sub-metric level lower than in the previous snapshot;
- a dimension score drop;
- an overall score drop;
- a sub-metric turning "not measurable".

**What the loop must do the same day, for each regressed sub-metric:** file or update exactly one `rt:self` issue.

- Fingerprint: `bench:<ID>`.
- Content: both values, the windows, the evidence, and a `Bench:` target line.
- If an open issue already carries the fingerprint, the loop updates that issue instead of filing a new one.
- A dimension or overall drop sets `priority:p1`.

**If the regression traces to a PR merged in the last 7 days,** that PR is a revert candidate under D4.

**Persistence:** a regression that lasts 3 snapshots goes into the owner digest.

## 9. Summary

| Dim | Sub-metric | Current value | Level | Level-5 target |
|---|---|---|---|---|
| U | U1 MTBI | 2.2 h | 1 | ≥72 h |
| U | U2 longest streak | 9.9 h | 1 | ≥72 h |
| U | U3 manual starts | 21 | 0 | 0 |
| U | U4 freeze self-recovery | 62% | 1 | 100% |
| U | U5 lost stages | 5 | 2 | 0 |
| U | U6 self-ledger slices | n/m | 0 | 7/7 |
| L | L1 days with self merge | 2/7 | 2 | 7/7 |
| L | L2 self acceptance | 24% | 1 | ≥80% |
| L | L3 self share of merges | 7.1% | 1 | ≥40% |
| L | L4 external issues/day | 20.7 | 0 | ≤3/week |
| L | L5 idle hours | 7.5 (proxy) | 2 | ≤1 h |
| I | I1 PR-shipped changes | 0% | 0 | 100% |
| I | I2 hand patches | 42 | 0 | 0 |
| I | I3 repeat-failure closure | 0/7 | 0 | 100% |
| I | I4 measured changes | n/m | 0 | 100% |
| I | I5 first-pass rate | 0.989 | 5 | ≥0.95 |
| D | D1 decision interventions | 11 | 1 | 0 |
| D | D2 longest owner wait | 13.6 h | 3 | ≤4 h |
| D | D3 self-settled | 75.6% | 1 | ≥98% |
| D | D4 rollback rate | 2.2% | 4 | ≤2% |
| D | D5 loop-merged share | 94.0% | 3 | 100% |

### Data gaps: events `rt-bench` needs

The loop must start writing these. All timestamps are UTC, and every text field passes the hygiene scan.

| Event (file) | Fields | Sub-metrics |
|---|---|---|
| `intervention`, written by the host loop (`.roundtable/state/interventions.jsonl`) | v, id, at, category, ref, reason, internalized, source, kind, followUp | U1, U2, U4, D1, L4, global |
| `self` entries (same ledger) | source=self, category, ref, reason | U6 |
| `freeze` (`.roundtable/state/freeze-ledger.jsonl`) | start, end, wallGapS, monoGapS, bootId, kind (host-freeze or scheduler-stall) | U1, U2, U4 |
| `sched-start` | at, pid, by (unit, watchdog or manual), reason, prevExit | U3, U4 |
| `stage-end` | at, issue, stage, rc, finalState, activeSec, wallSec, cause | U5 |
| `merge`, extending merges.log | pr, issue, origin (owner, decomposition, gate-finding, self-review, failure-repeat or metric-breach), parent, revertOf | L1, L3, D4, D5 |
| `issue-filed` / `issue-closed` | issue, source, origin, fingerprint, evidence[], rule; closeReason, pr, acceptanceEvidence | L1–L4 |
| `queue-snapshot` (per cycle) | at, running, claimable, depBlocked, mainRed, quotaWait, frozen | L5 |
| `deploy` / `host-patch` | at, fromSha, toSha, pr or tag, files[], kind (pr or hand), rollback | I1, I2 |
| `failure` | at, signature, issue, stage, detailHash | I3 |
| `change-eval` | pr, metric, baseline, window, expectedDelta, observedDelta, verdict | I4 |
| `usage` | at, issue, role, model, inTok, outTok, rc, parseOk | I4, I5 (tokens per merged PR) |
| `wait` | at, issue, state, waitingOn, redLine, questionKey, endedAt, endedBy (owner, external, self or timeout) | D2, D3 |
| `decision` | at, issue, kind, verdict (resolve, ask-owner, stop, invalid, fallback or timeout-default), by, rolledBack | D1, D3, D4 |
| `bench` snapshot (`.roundtable/state/bench.jsonl`) | at, window, per-ID value, level, source freshness | regression rule |
