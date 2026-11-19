# sequence-verifiable-units (distilled fallback)

Purpose: split work into units that can each be verified on their own, in order.

When to use: any task with more than one step, or any task that a reviewer must check in parts.

Steps:
1. List the outcomes the work must produce.
2. Cut the work into units. Each unit has one outcome and one check that proves it.
3. Order the units so each one depends only on units before it.
4. Run the check for each unit as soon as it is done, before starting the next.
5. Record the sequence: unit, check, result.

Rules:
- A unit whose check cannot be run is merged with a neighbor or marked not run.
- Do not start a unit whose dependency has not passed its check.

Done when: every unit has a recorded check result, and the order was followed.

Shared rules: see review-and-finish.md.
