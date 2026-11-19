# Review and finish (shared rules)

Harness-agnostic rules used by every required slot in this loop. Each slot file points here.

## Review findings

- A blocking review finding must be proven with a concrete trigger: the input, command, or sequence that produces the failure, and the observed result.
- A finding without a concrete trigger is advisory. Record it, but do not block on it.
- If a finding does not match the stated goal, record the evidence and leave the judgment to the owner.

## Verdicts and CI

- Green CI is not a verdict by itself. A reviewer still reads the change against the acceptance criteria.
- A red CI run blocks only when its failure is tied to the change.

## Finishing

- A duration is not a finish condition. Time spent does not make work done.
- Work is finished when every acceptance line has evidence: a command with its exit code, a file that was read, or a named receipt.
- If a step cannot be performed in this harness, write one skip line that names the step and why, then continue.
- Anything out of scope goes in the "incomplete items" list. Do not expand scope to finish it.
