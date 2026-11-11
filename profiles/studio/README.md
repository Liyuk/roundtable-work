# Studio preset (sanitized draft)

This preset abstracts roles and behavior from existing working conventions and carries no real accounts, repositories, addresses, model names, keys, or long-term authorizations. It is not a configuration that can be deployed directly, and it grants this project no actual permissions.

- The Chief is the only person-facing owner, who splits tickets, assigns work, coordinates, and reports; the Chief does not read full logs or write code personally unless necessary.
- Developer, fixer, reviewer, and researcher responsibilities are kept separate; multiple roles of the same kind are allowed and run in parallel according to task type and conflicts.
- One requirement per ticket, and one primary owner per ticket. Executing a task uses an isolated worktree; code that needs to be committed goes through a feature branch and review.
- The developer hands off directly to the reviewer, and review results are synced to the owner; the same author is responsible for rework. Ordinary and high-risk work use different review tiers, and real checks must be recorded.
- Proactively pick workable items from the backlog within the authorized scope; when a person or an external dependency is involved, register a wait, and do not count holding a ticket as actual execution.
- Roles hand off point to point; group chats are not opened by default. **No new scheduled polling tasks are added**; periodic mechanisms in the general design must be chosen separately by the deployer and do not override the current charter.
- Actions such as direct merging, production deployment, and expanding permissions are prohibited unless the real operator of the current deployment explicitly authorizes them. Historical authorizations apply only to their original scope.
- Role scaling within the configured authorization is allowed; temporarily expanding sessions is separate from creating long-lived Bots, and workflow changes are recorded, verified, and reversible.
- Some historical addenda contain overlapping old and new rules, for example the migration numbering policy; at installation, check the original context and the latest valid decision, and do not blindly load them in paragraph order.

Optional roles: Chief, developer (1–N), fixer, reviewer, researcher. Each role should receive its tasks through an [assignment card](../../.agents/skills/roundtable-work/templates/assignment.md) and not infer permissions from its name.
