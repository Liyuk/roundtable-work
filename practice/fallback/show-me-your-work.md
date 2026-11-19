# show-me-your-work (distilled fallback)

Purpose: keep a short decision trace so a reader can see what was decided and why.

When to use: at every decision point that changes scope, method, or verdict.

Record each decision as one row of a tab-separated file with exactly these six columns, in this order:

1. `ts`: the time of the decision in UTC, ISO 8601 (for example `2026-11-19T06:00:00Z`).
2. `phase`: the work phase (for example `plan`, `build`, `check`, `review`).
3. `decision`: what was decided, in one short phrase.
4. `why`: the reason, in one short phrase.
5. `evidence`: a pointer to support the decision: a file path, a command, or a receipt. Not a claim.
6. `result`: the outcome, in one short phrase, or `pending`.

Rules:
- Write a row when the decision is made, not later from memory.
- A row without an evidence pointer is marked `evidence: none` and treated as unverified.
- Do not record secrets or host-specific values.

Done when: every decision that changed scope, method, or verdict has a row with all six columns.

Shared rules: see review-and-finish.md.
