# blast-radius (distilled fallback)

Purpose: find what else a change can affect before it is accepted.

When to use: during review of any change to shared code, schemas, configuration, or public interfaces.

Steps:
1. List the files and symbols the change touches.
2. Search for callers and readers of each one (for example with a text search over the repository).
3. Note which callers depend on the changed behavior, and which only depend on unchanged parts.
4. Name the tests that cover the affected callers. Run them, or record that they were not run.
5. Write the radius as a short list: changed items, affected callers, tests run.

Rules:
- A wider radius needs a stronger check. Do not treat a small diff as a small radius.
- An affected caller with no test is an incomplete item, not a silent pass.

Done when: the radius list exists, each affected caller has a test result or an incomplete-item entry.

Shared rules: see review-and-finish.md.
