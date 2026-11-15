# Case: openbars, a Downstream Project Built with Roundtable (2026-11-11 to 2026-11-14)

A field record of a downstream project ([Liyuk/openbars](https://github.com/Liyuk/openbars), public) built with roundtable-work v0.2.1 by a local project steward session running on the owner's local machine. Only publicly visible GitHub data is used. Local session logs were not available, and gaps are marked as such. All times are PST. Snapshot: 2026-11-14 21:55 PST.

Framework-level follow-ups derived from this case are tracked in [#330](https://github.com/Liyuk/roundtable-work/issues/330) (for example #340 PR records, #341 review on a committed head, and #309 resuming rounds interrupted by quota limits).

## Key findings

1. **A Chief-led pipeline with owner sign-off, not a self-loop.** Of the 105 merged PRs, 94 merged within 1 minute of being opened. Branches are almost all `feat/` or `fix/`; only one is `rt/126-pi`. Implementation, review and rework happened locally, so GitHub holds only the results.
2. **The owner designs first, then issues are opened in batches.** Ten Discussions and the v0.1–v0.6 milestones each produced 5–13 issues within minutes. The median closed issue lived 74 minutes, and 47 closed within an hour. Decomposition happened earlier and finer than in roundtable-work itself.
3. **Rework is concentrated in a few hard spots.**
   - [PR #137](https://github.com/Liyuk/openbars/pull/137) (#116) went through 5 rounds, 3 of them extra rounds the owner approved.
   - [PR #153](https://github.com/Liyuk/openbars/pull/153) (#147) took 3 development and 4 review rounds, and the Chief session finished it itself.
   - Tokens and durations are not recorded on GitHub, so they cannot be quantified.

## Data scope and gaps

| Item | Value |
| --- | --- |
| Repository | Public; created 11-11 16:11, last push 11-14 02:43 |
| Issues | 101, 100 closed. Only #125 (upstream switch checklist) remains: its comments say it is done, but it was never closed |
| PRs | 107: 105 merged and 2 dependabot PRs closed; the merged PRs total +76,415 / −4,806 lines |
| Discussions | 10, used for version and design sign-off (e.g. #178, same-day mode, 8 comments) |
| main history | Rewritten on 11-13 22:29 into a single "Initial public release of OpenBars" commit; main now has 5 commits. The original PR commits are still readable through the API (e.g. 25e995d) |

Gaps:

- Local Chief and delegate session logs (wake counts, per-round time, token use, limit waits) were not available.
- There are no PR reviews on GitHub (0) and almost no PR comments (10). Review rounds and rejection reasons come from the "Roundtable record" section in PR bodies, which is self-reported.
- There was no PR-level CI before 11-13; #212 added it. Earlier "check.sh passed" claims are local self-reports.
- There is no evidence that a resident scheduler ever ran for this project, so no self-loop rounds are computed here.

Merged PRs per day (PST): 11-11: 58 · 11-12: 36 · 11-13: 9 · 11-14: 2. The 13 v0.1 issues were opened at 11-11 16:13; by 23:59 that day, 58 PRs had merged.

## 1. How far self-loop, self-iteration and "wish-style" programming got

| Goal | Status | Evidence |
| --- | --- | --- |
| Self-loop | Not used | No scheduler logs and no `rt:*` label flow. PRs were opened after local completion and merged the same minute; only PR #135 used the branch `rt/126-pi`. |
| Drop an issue in; it is finished | Achieved inside the Chief session | The Chief dispatched each issue to a developer (codex terra, later deepseek-flash), then to an independent reviewer (codex, luna, deepseek-v4-pro), and merged on a pass. Most PRs passed in one round. |
| Unsupervised self-decision | Bounded; hands off at the cap | Policy caps review at 2 rounds; past that, a PR is marked "needs repository owner decision" (e.g. PR #135, #137, #140). Out-of-scope findings were decided by the Chief and split into follow-ups (PR #143). |
| Self-iteration | Through roundtable version upgrades | PR #132 upgraded the vendored roundtable-work to b86fda2 (+614 / −614); PR #208 switched the workflow docs to English. The loop never changed its own rules. |

### Human interventions: counts and reasons

| Type | Count | Reasons and evidence |
| --- | --- | --- |
| Owner approved rounds beyond the cap | 5 rounds (3 PRs) | PR #135 round 3; PR #137 rounds 3, 4 and 5; PR #140 round 3 |
| Owner design sign-off | 10 Discussions; 5 issues cite a sign-off | Comments on #197, #202, #203, #206 and #207 record owner sign-off at 11-13 09:30 / 10:59 PT |
| Chief session implemented as a fallback | 2 | PR #134 was done by the Chief while the implementer was rate-limited. PR #153 still had blockers after three codex rounds, and the Chief finished it (7c0b845, 85accf7) |
| Interrupted by a model usage limit | 2 | `A-145-1` in PR #150 and `A-147-1` in PR #153 were cut off mid-session; each was finished by a "b" continuation session |
| Review misjudgment | 1 | PR #199: `R-195-1` rejected the change because it was not yet committed; `R-195-2` reviewed the working tree and passed |
| Manual dependency upgrade | 1 | Dependabot #214 and #215 were closed and replaced by a manual upgrade in PR #218 |

> Both independent review rounds rejected the change, which reaches the policy cap (2 rounds), so this PR is not merged for now and waits for a decision. (Roundtable record in PR #135)

## 2. How very large requests were decomposed

| Source | Split into | Time (PST) | Outcome |
| --- | --- | --- | --- |
| v0.1 architecture (Discussion #1) | #2–#14, 13 issues | Opened 11-11 16:13, all closed by 20:16 | 12 closed in about 4 h; #14 was a placeholder |
| #14 v0.2 crypto placeholder | #30–#34, then #43–#45 and #51 | Opened 11-11 19:59, closed by 21:01 | The placeholder turned cleanly into concrete issues |
| v0.3 A-shares (Discussion #54) | #55–#62 | Opened 11-11 21:03 | 6 closed within 40 min; #58 and #59 ran to 11-12 20:37 |
| v0.4 Hong Kong (Discussion #68) | #69–#77 | Opened 11-11 21:25 | 7 closed within 26 min; #73 and #74 needed broker-account evaluation and slipped to the next day |
| v0.5 local UI (Discussion #82) | #83–#89 | Opened 11-11 21:36, closed by 22:16 | 40 min |
| v0.6 hourly bars (Discussion #112) | #113–#120 | Opened 11-11 23:07 | #116 (canonical layer) took 5 rounds and merged at 01:09 |
| Same-day mode (Discussion #178) | #180–#185, absorbing #177 | Opened 11-12 12:31, closed by 16:52 | The batch cross-references itself, and comments state how issues were merged |
| Postgres decoupling (Discussions #194, #201) | #195–#197, then #202 and #203 | 11-13 | After owner sign-off, #197 was partly superseded by #203 |

What worked:

- **Design first, then split.** Each version settled its definitions in a Discussion, then opened a batch of issues with background, scope, acceptance criteria, source of the ported code, and dependencies (e.g. #2).
- **Labels by layer and market.** Labels cover the layer (provider, normalize, storage, cli, scheduler) and the market, and an issue usually touches one layer and one market. Merged PRs averaged about 770 changed lines, and most passed in one round.
- **Clear follow-ups.** #177 was split and folded into #181 and #183, and it was closed with PR and commit references.

What did not:

- **Hard parts were not split out in advance.** #116 (hourly canonical layer and identity rules) put daily and hourly identity rules into one issue. Round 4 of rework then introduced a new blocker (PR #137).
- **Some issues depended on external conditions.** #73 (Futu) and #74 (LongPort) needed account evaluation, and #58 and #59 took almost a day, out of step with their batches.
- **Pre-release changes were not split.** PR #208 changed +4,870 / −2,084 lines and PR #217 +2,820 lines.

## 3. Redundancy, rework and waste

| Problem | Quantity | Evidence |
| --- | --- | --- |
| Rework continued past the review cap | PR #137: 5 rounds (5 development, 5 reviews) | Round 4 introduced a new identity-mismatch blocker; round 5 reverted round 4's wiring change and passed |
| Multiple development and review rounds | PR #153: 3 development rounds, 4 reviews, then finished by the Chief | Review rejected rounds 1–3 and passed round 4 |
| Other multi-round rework | PR #140: 3 reviews; #135: 3 rounds; #186: 3 fix rounds; #141, #138, #136 and #190: 2 rounds each | Roundtable records in PR bodies |
| Interrupted by limits | 2 (PR #150, #153) | "interrupted by the codex usage limit; finished by A-145-1b" |
| Review misjudgment | 1 (PR #199) | The reviewer did not look at the working tree and judged uncommitted changes as missing |
| Toolchain switching | 4 combinations | Development moved from codex terra to deepseek-flash; review used codex, luna and deepseek-v4-pro; UI used opus-5-5 and haiku-4-5 (PR #208). #16 had set "default pi (Claude Sonnet tier)" |
| History rewrite | main has 5 commits | Squashed into one commit before release on 11-13 22:29; commit ids cited in issue comments (e.g. 25e995d) are no longer on main |
| Housekeeping not finished | 1 | #125 says done but is still open |

Not quantifiable: per-session tokens, limit-wait time and idle wakes. That data stays on the local machine and is not on GitHub.

## 4. Improvements, ranked by benefit

1. **Record rounds and time as structured data.** Attach a machine-readable roundtable ledger (rounds, models, time, tokens) to each PR, or push one to a log outside the repository. Today only self-reports can be read, so a later review cannot quantify anything. (Framework: #340)
2. **Split out identity rules first.** For issues like #116 that touch several data models, open a separate "definitions sign-off" child before implementation, so a fourth round of rework cannot introduce a new blocker. (Framework: #331)
3. **Wire CI to PRs from the start.** #212 came too late. With CI in place, reviewers see objective check results, not just self-reported `check.sh` runs.
4. **Review only committed state.** The PR #199 misjudgment shows reviewers should always review the committed diff. (Framework: #341)
5. **Pin model routing and write it into `team.md`.** What was actually used differs from the pi (Sonnet tier) default agreed in #16; update the docs whenever models change.
6. **Do not squash history before release.** Or keep a PR-to-commit mapping in the docs, so commit ids cited in issues stay valid.
7. **Regularly close issues that are done but still open** (#125).

## Evidence

- [PR #137](https://github.com/Liyuk/openbars/pull/137): #116 hourly canonical layer, 5 rounds (3 approved by the owner)
- [PR #153](https://github.com/Liyuk/openbars/pull/153): 3 development and 4 review rounds, finished by the Chief
- [PR #135](https://github.com/Liyuk/openbars/pull/135): waiting for the owner's decision after the 2-round cap
- [PR #16](https://github.com/Liyuk/openbars/pull/16): installs roundtable-work v0.2.1 and the collaboration rules
- [PR #199](https://github.com/Liyuk/openbars/pull/199): review misjudgment (uncommitted change)
- [Discussion #178](https://github.com/Liyuk/openbars/discussions/178): same-day mode design, split into #180–#185
- [#14](https://github.com/Liyuk/openbars/issues/14): v0.2 placeholder split into #30–#34
- [#125](https://github.com/Liyuk/openbars/issues/125): says done, still open
