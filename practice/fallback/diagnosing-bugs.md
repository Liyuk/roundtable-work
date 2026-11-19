# diagnosing-bugs (distilled fallback)

Purpose: find the root cause of a bug before changing code.

When to use: a failing test, a reported defect, or a behavior that differs from the spec.

Steps:
1. Reproduce the bug with a command or test. Record the exact command and output.
2. Narrow the input: remove steps until the smallest trigger remains.
3. Form one hypothesis about the cause. Name the code path and the state it depends on.
4. Test the hypothesis with a read or a probe. Confirm or reject it with evidence.
5. Fix the cause, not the symptom. Add a regression test that fails before the fix.
6. Check neighbors: other callers of the same path that could show the same cause.

Rules:
- Do not change code until the cause is named and supported by evidence.
- If three hypotheses in a row are rejected, stop and record what was learned.

Done when: the reproduction now passes, the regression test fails before the fix and passes after, and the cause is written down.

Shared rules: see review-and-finish.md.
