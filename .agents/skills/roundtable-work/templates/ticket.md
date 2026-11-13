# Ticket: <title>

- ID / parent goal / target version:
- User's original words and refined goal:
- Owner / created time:
- Source and authorization basis:
- Status / next action / executor:
- Workspace / allowed and forbidden actions:
- Risk level / budget (time, cost, attempts):
- Dependencies / concurrent conflicts / waiting for and wake-up conditions:

## Acceptance Criteria

- [ ] <verifiable condition; note whether automatic or manual evaluation>

## Pre-claim admission fields

Use these headings in the issue body or in a complete Chief draft comment marked `<!-- rt:admission-draft -->`:

- `## Goal`: the work outcome.
- `## Acceptance criteria`: include `Run: \`<concrete command>\`` and `Expected: <observable result>`.
- `## Out of scope`: explicit boundaries, or `None`.
- `## Dependencies`: issue references, or `None`.
- `## Size estimate`: `Changed lines: <integer>` and `Files: <integer>`; estimates above 400 changed lines or 5 files require decomposition.

Missing fields are returned as structured admission reasons and are not claimed. A person is asked only when the draft explicitly says `Needs human decision: yes`; missing, invalid, or over-limit size is refused with `decompose`.

## Work Record and Delegation

- <time, event ID, assignment, result or evidence link>

## Delivery and Incomplete Items

- Artifacts and target version of basis:
- Checks, review and evidence:
- Incomplete, unknown external side effects:
- 下一步 (Next steps) and decisions requiring human input:
