# prove-it-works (distilled fallback)

Purpose: show that a claimed result actually works, with evidence a reader can rerun.

When to use: before reporting a change as done, and before a reviewer is asked for a verdict.

Steps:
1. Restate each claim as a checkable statement, tied to an acceptance line.
2. For each claim, choose one command or read that checks it.
3. Run the command. Record the command, the exit code, and the relevant output.
4. If a claim cannot be checked here, mark it "not run" and say why.
5. Report results per claim: pass, fail, or not run.

Rules:
- Evidence is what was executed or read, not what was expected to happen.
- Do not report a number that was not produced by a command.
- A claim that fails is reported as fail, even if other claims pass.

Done when: every claim has a pass, fail, or not-run entry with its evidence pointer.

Shared rules: see review-and-finish.md.
