# Field Cases

Field records of real iterations run with Roundtable Work: what the loop achieved, where people still had to step in, how large requests were decomposed, where time and tokens were wasted, and the improvements that followed. Each case is anonymized: machine names, hosts, paths, accounts and personal details are generalized ("host machine", `<host>/...`, "supervisor", "Chief session"). Only public issue and PR links, statistics, dates with PST times, conclusions and recommendations are kept.

| Case | Period | Summary |
| --- | --- | --- |
| [roundtable-work self-loop](2026-11-roundtable-self-loop.md) | 2026-11-11 to 2026-11-14 | Four days of the repository developing itself with the host-side scheduler: 107 merged PRs, decomposition outcomes, host-level losses (freezes, stalls, quota idling, series bug). Follow-ups in #330 |
| [openbars downstream project](2026-11-openbars.md) | 2026-11-11 to 2026-11-14 | A downstream project built in Chief-led mode: 105 merged PRs in about 58 h, design-first batch decomposition, rework hot spots, and missing review records |

## Adding a case

Name new cases `YYYY-MM-<subject>.md` and follow the same sections:

1. Key findings
2. Data scope and gaps
3. How far self-loop, self-iteration and wish-style programming got, including human interventions
4. Decomposition of large requests
5. Redundancy, dead loops and waste (quantified)
6. Improvements ranked by benefit
7. Evidence

Then add a row to the table above, and link any follow-up issues.
