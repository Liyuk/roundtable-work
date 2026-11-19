# correct (distilled fallback)

Purpose: fix a delivered result that a review rejected, without changing the goal.

When to use: after a reject verdict, or when a check run after delivery fails.

Steps:
1. Read the rejection and list each finding with its trigger.
2. Reproduce each finding. Confirm it is real before changing code.
3. Fix the specific findings. Do not widen the change.
4. Re-check every acceptance line, not only the rejected ones, and record pass or fail for each.
5. Hand back with the list of findings and the evidence that each is resolved.

Rules:
- A finding that cannot be reproduced is reported back with the evidence, not silently dropped.
- A finding that conflicts with the goal is left to the owner with the evidence.

Done when: each finding has a resolution with evidence and every acceptance line is re-checked.

Shared rules: see review-and-finish.md.
