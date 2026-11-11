# Roundtable Work Pages demo: content outline

Status: slice 1 of 4, covering the content specification, the visual direction and an audit of the data. This file is a specification for a later static site. It contains no site code, workflow or behavior change. Everything is written in English as new authoring; it restates facts from the repository's existing design documents and does not translate them.

Companion files in this folder:

- `scenario.json`: the synthetic data the demo will step through.
- `privacy-audit.md`: the data and claims audit for this content.

Machine-contract words stay unchanged wherever they are shown: the reviewer verdict line `审查结论：通过 | 打回 | 阻塞` (English gloss: approved | rejected | blocked), the continuation decisions `continue`, `wait`, `ask`, `done`, `stop`, and the ticket state words such as `queued`, `assigned`, `working`, `review`, `ready`, `done`, `waiting_person`, `unknown`.

## 1. Audience and purpose

Audience:

- Engineers and technical leads deciding whether a role-based agent workflow is worth trying.
- Maintainers and reviewers who want to see exactly what is and is not implemented.
- Newcomers who need a short, honest picture before reading the design documents.

Purpose:

- Explain the workflow: a human goal, a Chief, executor roles, checks, an independent review, a pull request and a human merge.
- Show a safe, synthetic walkthrough that makes the handoffs, the failures and the pauses visible.
- State plainly what exists today and what is only a plan.

Non-goals:

- It is not a product page, a status page or a live dashboard.
- It does not run agents, does not call any service and does not accept input that reaches a real repository.
- It does not claim continuous availability or that failures can be recovered from.

## 2. Hard constraints for every later slice

1. Synthetic data only. Nothing is copied from real issues or comments, and no real code changes, logs, machine paths, secrets or deployment internals appear.
2. No 24/7 availability claim and no recovery promise anywhere, including alt text, metadata and share cards.
3. No automatic merge and no privileged action from the demo. Merge is shown as a human-only step outside the demo.
4. Static output, no backend, no secrets, no third-party scripts that send data.
5. Accessible by default (see section 4).
6. Human review before any merge or deploy of the site itself.
7. Every capability statement is either backed by a repository path in the table in section 9, or marked planned, or left out.

## 3. Visual direction

Tone:

- Calm, precise and plain-spoken. Short sentences. No hype words, no superlatives, no countdown or uptime imagery.
- The voice is a careful colleague explaining a process, not a sales pitch.

Look:

- A "round table" motif used lightly: a circular layout of roles around the ticket, with the human at the top and the merge decision outside the circle.
- Palette ideas: a warm off-white background, deep ink text, one teal accent for the normal flow, amber for waiting or asking, and a muted red for stop or rejection. Always pair color with a text label and an icon shape so color is never the only signal.
- Provide a light theme and a dark theme that follows the system setting, and check contrast in both.
- Typography: a readable system font stack, generous line height, and a monospace face for the machine-contract words.

Motion:

- Motion is optional and meaningful: a role highlight and a card moving between roles during a step.
- Respect `prefers-reduced-motion`: with the preference set, no movement at all. Steps change instantly and the same information is shown as text.
- Nothing autoplays without a visible pause control. Playback pause, step forward and step back are always available (see section 7).
- No flashing, no parallax, no looping decorative animation.

Accessibility requirements:

- Semantic landmarks and one `h1`; headings in order.
- The whole walkthrough works with the keyboard alone and without JavaScript: a no-script fallback renders every step as an ordered list from the same data.
- Visible focus styles; controls have accessible names; state changes are announced through a polite live region.
- Meet WCAG 2.2 AA contrast; text can be resized to 200 percent without loss; layout works on small screens.
- Diagrams have text equivalents. The failure table and the claims table are real tables with header cells.
- A visible banner near the top says the content is synthetic.

## 4. Site outline

The site is static. One landing page and one walkthrough page are enough; slice 2 may merge them into a single page with anchors. Each block lists its data source.

### Page A: Overview

| Section | Content | Data source |
| --- | --- | --- |
| A1. Header and banner | Name, one-sentence description, and a banner that says the content is synthetic and not a live system. | `scenario.json` `title`, `disclaimer` |
| A2. What it is | Roundtable Work is a skill and configuration for existing agent hosts: one Chief owns the goal, other roles work in separate sessions, and handoffs use ticket, delegation card, delivery card and checkpoint record. | this file, sections 5 and 9 |
| A3. The flow at a glance | The line: human goal, Chief, developer, test gate, scope gate, independent reviewer, Chief commit, pull request, human merge. Text first, diagram second. | `scenario.json` `steps` |
| A4. Roles | Cards for Chief, developer, fixer, reviewer and researcher. | `scenario.json` `actors` |
| A5. Implemented vs planned | The table in section 9, rendered as a real table. | `scenario.json` `claims`, `limits` |
| A6. Limits | The list in section 8. | `scenario.json` `limits` |

### Page B: Walkthrough

| Section | Content | Data source |
| --- | --- | --- |
| B1. Scenario intro | The fictional Notekeep app, the invented task and the invented IDs, with the synthetic banner repeated. | `title`, `disclaimer` |
| B2. Stepper | Seventeen ordered steps. For each: the actor, phase, title, summary, artifacts, the gate result if any, the ticket state and the decision if any. Previous, next and playback pause controls. | `steps` |
| B3. Rejection and fix | The review rejection (step s10), the rework and the approval (step s14), with the verdict line shown exactly as `审查结论：打回` and `审查结论：通过`. | `steps` |
| B4. Ask the human | The pause for question Q1 (steps s05 and s06). | `steps` |
| B5. Human merge | The last step is shown as human-only and outside the demo. No button performs a merge. | `steps` |
| B6. When things go wrong | A table of alternative branches (section 6). | `failureRecovery` |
| B7. Pause controls | A glossary of the controls (section 7). | `pauseControls` |

## 5. Architecture narrative

This is the text the site explains, in plain language. Each statement is covered by the table in section 9 or is marked planned.

**A human sets direction.** The human gives the goal, the acceptance and the limits, and can correct, pause or stop at any time. Anything that needs new authority, or is irreversible, goes back to the human.

**The Chief owns the goal.** The Chief is the main contact. It writes the ticket (the original words, a target version, checkable acceptance, authorization and budget), splits the work, delegates, reads the results and decides what happens next. By default the Chief delegates implementation to the executor roles; it may do small, low-risk work itself, which is marked as Chief-self-done and is also sent to independent review. Each unit of work has exactly one owner.

**Roles do the work in separate sessions.**

- Developer: turns a delegated task into a verifiable artifact and reports in a delivery card. It does not commit by default.
- Fixer: handles a delegated bug, reproduces it first with a failing check and then fixes it.
- Researcher: answers a bounded question with sources, and separates observation from inference.
- Reviewer: judges the delivery against the original goal and acceptance, in a session separate from the author's.
- A role is not a model. Isolation gives a fresh viewpoint, but a different model or name is not proof of quality.

**Handoffs are structured.** The delegation card carries the assignment ID, the ticket, the target version, acceptance, workspace, allowed files and what is forbidden. The executor returns a delivery card: result, artifacts, the checks it actually ran, the checks it did not run, risks and what needs a decision. Delegation events (sent, delivered, acknowledged, started, returned) are only recorded when the host gives a receipt; otherwise the record says not confirmed.

**Checks before review (demo labels: test gate and scope gate).** After a delivery the Chief does not trust the report. It reads the evidence, runs the final full check, and compares the changed files with the allowed scope, for example from the version-control status. These two checks are written as instructions that an agent follows. The names "test gate" and "scope gate" are labels used by this demo for those two checks; they are not an automated enforcement engine.

**Independent review.** A separate reviewer session checks the delivery against the ticket. The first line of its card is the verdict, `审查结论：通过 | 打回 | 阻塞` (approved | rejected | blocked). A rejection goes back to the original author. After a change in behavior or tests the work is reviewed again. A review by the author's own session is only a self-check, not an independent review. Independent review reduces shared blind spots but is not proof of correctness.

**Chief commits, a pull request is opened, a human merges.** Executors do not commit by default. After a review passes, the Chief commits on a feature branch. In this synthetic setup the deployment policy allows the Chief to open a pull request; a real deployment depends on its own policy. A pull request states the problem, the change, the checks actually run, the checks not run and the risks. Merging to the main branch, publishing and deploying need the human; the default policy lists them as actions to ask about first.

**Every Chief turn ends with a decision.**

| Decision | Meaning in the demo |
| --- | --- |
| `continue` | Do the next step now, in this turn. |
| `wait` | Wait for a named event and say how the wake-up would happen. Other independent work can go on. |
| `ask` | A human decision is needed for one item. Only that item is suspended. |
| `done` | Every acceptance item has evidence. |
| `stop` | The budget is spent, there is no progress, the risk is too high or authorization is gone. |

**Budgets stop loops.** The policy template's defaults are at most 2 attempts per assignment, at most 2 review rejections before a human decides, and stop after 2 turns without progress. A deployment can change them.

## 6. Failure and recovery states

The demo shows these branches from `scenario.json` (`failureRecovery`). The wording on the site must say what the Chief does, never that recovery will succeed.

| ID | Trigger | What the Chief does | Honest outcome |
| --- | --- | --- | --- |
| f01 | The host cannot start a separate reviewer session | Does not approve its own work; labels any same-session check a self-check; asks the human | Review stays pending until a human decides |
| f02 | Reviewer rejections pass the configured limit | Stops automatic rework and hands the case to the human | A person decides |
| f03 | A test gate fails | Does not accept the work or send it to review; returns the failing output to the author within budget | May pass later, or ends in f04 |
| f04 | The attempt budget is used up | Records `stop`, reports what was tried and the decision needed | Work halts |
| f05 | Two turns bring nothing new | Records `stop` instead of repeating | Work halts and is reported |
| f06 | A scope gate finds an out-of-scope write | Does not accept the work; reports the change | Held until a person or the Chief settles scope |
| f07 | The result of an external action is unknown | Marks it `unknown`, checks the real state, does not repeat blindly | Some outcomes may stay unknown |
| f08 | The session ends while waiting | Nothing wakes by itself; a host feature or the human must resume | May sit idle |

## 7. Pause controls

Real controls described by the repository's instructions (`pauseControls` p01 to p05):

- Human pause, correction or stop: the human can do this at any time. The Chief handles the correction before new work. Whether a running sub-session can be interrupted depends on the host.
- `wait`: the Chief names the event and the wake-up method. It does not promise that a wake-up exists.
- `ask`: one item is suspended with a concrete question and a recommendation. The rest continues.
- `stop`: used for spent budget, no progress, excess risk or lost authorization.
- Human merge: merging is a human decision, outside the demo.

Visual control only (p06): demo playback pause and step. It pauses the animation on the page and nothing else. The page must say this so nobody reads it as a real system control.

## 8. Limits section

Text for the site, matching `scenario.json` `limits`:

- This is a synthetic walkthrough, not a recording of a real run.
- Roundtable Work is a skill and configuration for existing agent hosts. It has no background runtime of its own, and the demo makes no claim of 24/7 operation.
- A turn ending is not a wake-up. Resuming without a person depends on host features that have not been verified here.
- Nothing here promises that any failure can be recovered from; some work will stop and need a person.
- Independent review reduces shared blind spots but is not proof of correctness.
- Test and scope gates are Chief verification steps described in instructions and performed by an agent; they are not automatically enforced by a runtime.
- The demo performs no merge, deploy or other privileged action. Merging is a human decision outside the demo.
- The default budgets are template defaults that a deployment may change.

## 9. Implemented today vs planned / not claimed

"Implemented" here means written down in the repository as instructions, templates, scripts or CI. It does not mean that a background service exists, and it does not mean the behavior has been measured in a live run. The evidence column is a repository path that was checked to exist.

| Statement | Status | Evidence |
| --- | --- | --- |
| Five roles with separate instructions: Chief, developer, fixer, reviewer, researcher | Implemented (instructions) | `.agents/skills/roundtable-work/SKILL.md` |
| Structured ticket, delegation card, delivery card and checkpoint templates | Implemented (templates) | `.agents/skills/roundtable-work/SKILL.md`, `.agents/skills/roundtable-work/templates/ticket.md`, `.agents/skills/roundtable-work/templates/assignment.md`, `.agents/skills/roundtable-work/templates/delivery.md`, `.agents/skills/roundtable-work/templates/checkpoint.md` |
| Every Chief turn ends with one of the five continuation decisions; the shared state vocabulary | Implemented (instructions) | `.agents/skills/roundtable-work/SKILL.md`, `.agents/skills/roundtable-work/prompts/shared.md` |
| Chief reads evidence, checks for out-of-scope writes and runs the final full check (the demo's test and scope gates) | Implemented (instructions followed by an agent, not automated enforcement) | `.agents/skills/roundtable-work/prompts/roles/chief.md` |
| The reviewer's card starts with the verdict line; an independent session or a different model is not proof of correctness | Implemented (instructions) | `.agents/skills/roundtable-work/prompts/roles/reviewer.md` |
| Review must be by a different session than the author; a review by the same session is called a self-check | Implemented (instructions) | `.agents/skills/roundtable-work/prompts/roles/chief.md` |
| Executors do not commit by default; Chief commits after review passes | Implemented (instructions) | `.agents/skills/roundtable-work/SKILL.md` |
| Default budgets: 2 attempts, 2 review rejections, stop after 2 turns without progress | Implemented (policy template defaults) | `.agents/skills/roundtable-work/templates/policy.md` |
| Merge, publish and deploy need the user's approval first | Implemented (policy template default) | `.agents/skills/roundtable-work/templates/policy.md` |
| Installer and read-only doctor scripts; doctor reports background wake-up as unverified | Implemented (scripts and a test) | `scripts/doctor.mjs`, `scripts/install.mjs`, `test/doctor.test.mjs` |
| CI runs the install and test commands on pushes and pull requests | Implemented (CI) | `.github/workflows/check.yml` |
| Pull requests link an issue and report checks run and not run | Implemented (convention and template) | `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md` |
| Host capability mapping with the rule that unsupported tools are treated as unsupported | Implemented (reference) | `.agents/skills/roundtable-work/references/harnesses.md` |
| Background wake-up of the Chief after a turn ends | Planned, not claimed; depends on the host and is unverified | `docs/11-chief-continuous-loop.md` |
| Loop that turns external events into issues and queued work | Planned, not claimed; candidate design with no receiving service | `docs/12-events-and-memory.md` |
| Restart recovery with outbox, idempotency keys and lease fencing | Planned, not claimed; design only | `docs/05-execution-and-safety.md` |
| Executor adapter with probe, start, observe, cancel and recover | Planned, not claimed; design only | `docs/05-execution-and-safety.md` |
| Test and scope gates enforced automatically by a runtime. The gates are Chief verification steps described in instructions and performed by an agent, not automatically enforced | Not implemented; not claimed | `.agents/skills/roundtable-work/prompts/roles/chief.md` |
| This demo site and its Pages deployment | Planned (later slices) | `docs/pages-demo/scenario.json` |

Rows marked planned, or "Not implemented; not claimed", are listed so readers can see the boundary. The site must not describe them in the present tense.

## 10. Notes for later slices

- Render every table from `scenario.json` where a matching key exists, so the text and data cannot drift apart.
- Run `npm test` before proposing the site; the content test in `test/pages-demo-content.test.mjs` guards the schema, the forbidden patterns and the claim wording.
- Open questions for the human: whether the site should be one page or two; the repository's final language policy for the Chinese design documents that the evidence column points to; whether to keep the `evidence` and `decision` fields that this slice added to the scenario schema.
