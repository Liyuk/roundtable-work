# code-review (distilled fallback)

Purpose: decide whether a change meets its acceptance criteria and is safe to accept.

When to use: after implementation, before the change is marked ready.

Steps:
1. Read the acceptance criteria first, then the diff.
2. Check each criterion against the diff and against a command or read that proves it.
3. Look for behavior that the criteria do not mention and that could break callers (see blast-radius.md).
4. For each blocking finding, write the concrete trigger and the observed result.
5. Write the verdict: pass, reject, or block, with the findings that justify it.

Rules:
- A blocking finding needs a concrete trigger. Without one, record it as advisory.
- Green CI is not a verdict by itself.
- Do not refactor during review. Report refactors as advisory items.

Done when: every criterion has a pass or fail with evidence, and the verdict line is written.

Shared rules: see review-and-finish.md.
