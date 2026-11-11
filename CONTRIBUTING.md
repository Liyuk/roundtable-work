# Contributing

## From idea to delivery

Features, designs, and general improvements are first discussed in Ideas or General under [Discussions](https://github.com/Liyuk/roundtable-work/discussions), covering the goal, the approach, and acceptance; once there is consensus, create one or more Issues. Each Issue links to the original Discussion and states the scope, acceptance, dependencies, owner, and boundaries for parallel work. After an executor claims an Issue, they submit a PR; the PR links the Issue with `Closes #number` and includes the Discussion link; for multiple tasks, link each one separately.

A bug can be filed directly as a Bug Issue, stating the reproduction steps, expected and actual results, environment, and evidence; after it is claimed, submit a fix PR that links the Issue. Add a Discussion link when there is a genuinely related design discussion. For security issues, do not post sensitive details publicly; contact the repository maintainers first.

Discussing, claiming, and linking are collaboration conventions; the templates help put them into practice, and they do not mean automatic execution or bypassing GitHub permissions. A PR description states the problem, the implementation, the real checks, what is unfinished, and the risks; a check that was not run must not be marked as passed. Do not commit credentials, personal information, or private project records.

## Local checks

Use Node.js 24 (see `.nvmrc`) and run `npm ci` and `npm test`. The tests cover the install script and diagnostics and check local Markdown links; they are not tests of the agent runtime. When adding an npm dependency or GitHub Actions, update the lock file and keep the Dependabot configuration.

## Changing runtime instructions

Runtime instructions and templates live only in `.agents/skills/roundtable-work/`; `docs/` holds the design rationale. The skill directory is copied as a whole into the user's workspace, so links inside it must not point outside the directory (`npm run check` rejects them). When behavior changes substantively, bump `metadata.version` in `SKILL.md`; `install.mjs --update` and `doctor --target` depend on this version number. After changing a prompt, it is best to run the [practice protocol](practice/README.md) once in a real harness and record the result.
