# tdd (distilled fallback)

Purpose: build or fix behavior test first, in small vertical slices.

When to use: a feature, a bug fix, or any change that has an observable behavior.

Steps:
1. Name the behavior and the seam (the public interface the test calls). Keep the seam small.
2. Write one failing test that states the expected behavior. Run it and confirm it fails for the expected reason.
3. Write the least code that makes that test pass. Do not add behavior no test asks for.
4. Run the test again and confirm it passes. Run the full suite once at the end.
5. Repeat with the next behavior. Do not write all tests first.

Rules:
- Test through public interfaces. Do not mock internal collaborators or test private methods.
- Expected values come from a known literal or the spec, never recomputed the way the code computes them.
- Refactoring is a separate step after green, not part of the red-to-green loop.
- If a seam is unclear, record the question and state the seam you chose.

Done when: each new behavior has a test that failed before the change and passes after, and the full suite passes.

Shared rules: see review-and-finish.md.
