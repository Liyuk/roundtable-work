# implement (distilled fallback)

Purpose: deliver a spec or ticket as working code with the smallest change that meets it.

When to use: any implementation task with written acceptance criteria.

Steps:
1. Read the spec or ticket and state the acceptance criteria as a list.
2. Check the scope: which files may change, and which must not.
3. Write a failing test for the first criterion (see tdd.md). Confirm it fails.
4. Write the least code that passes it. Repeat for each criterion.
5. Run the single test file after each change, and the full suite once at the end.
6. Run any typecheck or lint the project defines. If none exists, record that as a skip.
7. Hand off with the delivery record: files changed, commands run with exit codes, criteria with evidence.

Rules:
- Keep to the scope. Problems outside it go into the incomplete-items list.
- No speculative code, no extra guards for states that cannot happen.

Done when: every criterion has a passing test or a recorded check, and the full suite has been run.

Shared rules: see review-and-finish.md.
