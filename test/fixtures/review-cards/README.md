# Review card replay fixtures

Synthetic reviewer delivery cards for issue #173. Every card starts with the first-line verdict
`审查结论：打回` and embeds its review ledger as a fenced `json` block. No card contains host, path, or
personal data from a real session.

`test/runtime/review-card-replay.test.mjs` extracts the ledger `findings` from each card, replays the
card text through `runtime/lib/classify.mjs` as a reviewer event, and asserts the table below.

| Card | Expected class | Decision | Reason | Developer retry |
| --- | --- | --- | --- | --- |
| `reject-01-evidenced.md` | `review_rejected` | `continue` | — | yes |
| `reject-02-unevidenced.md` | `reviewer_unavailable` | `wait` | `unevidenced_blocking_findings` | no |
| `reject-03-mixed.md` | `reviewer_unavailable` | `wait` | `unevidenced_blocking_findings` | no |

Rules the table demonstrates:

- A `blocking` or `in-scope miss` finding must carry a non-empty `evidence` string: `file:line` plus the
  command and its output, or a named failing/added test.
- If any such finding lacks evidence, a rejection verdict is malformed: it is treated as an unavailable
  reviewer, the run waits, and the gates retry the reviewer once instead of spending a developer retry.
- `out-of-scope follow-up` findings need no evidence.
