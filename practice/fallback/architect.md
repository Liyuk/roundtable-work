# architect (distilled fallback)

Purpose: shape a design before code is written.

When to use: new-module or cross-module design only. Do not use it for a change inside one existing module.

Steps:
1. State the problem and the constraint that matters most.
2. Name the module boundary: what the new module owns, and what it only reads.
3. List the interface: inputs, outputs, and the failure each one can return.
4. Compare at most two options. For each, state the cost to change it later.
5. Record the decision and the reason in one short paragraph.

Rules:
- Keep the design as small as the acceptance criteria require.
- Do not add extension points that no current caller uses.
- If the design needs a new dependency, name it and say why.

Done when: the boundary, interface, and decision are written down and a reviewer can check them against the acceptance criteria.

Shared rules: see review-and-finish.md.
