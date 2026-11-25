# Role-to-Model Routing

Status: implemented in `runtime/lib/routing.mjs` and wired through `runtime/rtd.mjs`.

A deployment routes each role to a harness, a model, and a model tier through one table. Role prompts do not name or ban models; the runtime appends a `Routing for this run` facts block to the rendered role prompt instead.

## Roles and tiers

The table must define exactly these seven standing roles (`ROLES` in `runtime/lib/routing.mjs`):

`chief`, `researcher`, `developer`, `fixer`, `reviewer`, `verifier`, `security`

Tiers are ordered low to high: `economy`, `standard`, `strong`. A window's `reviewer` and `fixer` must be at least the `developer` tier, so review and repair are never graded below implementation. The `reviewer` must be `strong`; its second pass (below) runs under that role.

## Legacy role aliases and the alias window

`ROLE_ALIASES` in `runtime/lib/routing.mjs` maps legacy names to a canonical role. The canonical names resolve to themselves. Tables and config files may still use an alias key; `canonicalizeRoles` renames it to the canonical role, and two keys for one role are an error.

| Canonical role | Legacy aliases |
| --- | --- |
| `fixer` | `opus-fix` |
| `reviewer` | `xcheck`, `crosscheck`, `cross-reviewer` |
| `verifier` | `decider`, `acceptor`, `tester` |
| `security` | `threat`, `exploit`, `threat-modeler`, `red-teamer` |

The aliases come from the rename in #560 (landed 2026-11-18). They stay in force until the **later** of:

- (a) a follow-up issue after the RT-P3 series merges and removes them, or
- (b) 14 days after the rename landed.

Therefore the alias window lasts no earlier than **2026-12-02**. This is the only place the window is stated.

## Table schema

Version 1 uses ISO timestamps and one or more non-overlapping, sorted windows:

```json
{
  "version": 1,
  "windows": [
    {
      "id": "2026-11",
      "from": "2026-11-01T00:00:00.000Z",
      "to": "2026-12-01T00:00:00.000Z",
      "roles": {
        "chief": { "harness": "pi", "model": "model-chief", "tier": "standard" },
        "researcher": { "harness": "pi", "model": "model-research", "tier": "standard" },
        "developer": { "harness": "pi", "model": "model-dev", "tier": "standard" },
        "fixer": { "harness": "pi", "model": "model-fix", "tier": "standard" },
        "reviewer": { "harness": "pi", "model": "model-review-strong", "tier": "strong" },
        "verifier": { "harness": "pi", "model": "model-verify", "tier": "standard" },
        "security": { "harness": "pi", "model": "model-security", "tier": "strong" }
      }
    }
  ]
}
```

`model-dev`, `model-review-strong`, and the other ids above are illustrative, obviously fake names; deployments replace them with locally probed ids and must not treat the examples as available models.

Validation (`validateRouting`) rejects: a version other than 1; empty, duplicate-id, unsorted, overlapping, or invalid-timestamp windows; a missing or unknown role, naming the window and role; an empty `harness` or `model`; an unknown tier; a `reviewer` or `fixer` tier below `developer`; and a `reviewer` tier other than `strong`, naming the window and role. A valid table is returned unchanged; the runtime invents no defaults.

## Active window and prompt injection

For a run, `activeWindow(config, now)` selects the window where `from <= now < to`. If no window covers `now`, it throws a `RoutingError` (`code: 'ROUTING_INVALID'`, message prefixed `routing `). `routingFacts(config, now)` returns `{ window: <id>, roles: { <role>: { harness, model, tier } } }`.

`formatRoutingFacts(facts)` renders a Markdown block that starts with `## Routing for this run` and lists one line per role:

```text
- reviewer: harness=pi model=model-review-strong tier=strong
```

The block states that a receipt naming the routed model for its role is expected and allowed, and that only a model absent from the block is a configuration error to report and continue around. `renderRolePrompt(promptText, facts)` appends this block after the role prompt, so the facts are part of the assembled context. The block is the only routing source in prompts; it replaces hard-coded model names and one-tier-for-all wording.

## Gate models and fail-closed behavior

`rtd.mjs --routing FILE` loads and validates the table at startup, before any queue read, lock, or pass. A missing or invalid table prints the `routing ...` error and exits `2`. A valid table supplies `models.reviewer` and `models.crossCheck` to every `runGates` call in the pass.

- Gate 1 (review) runs under the `reviewer` role.
- Gate 2 (second pass, see below) runs under the `reviewer` role and its model.
- Safety-file approval must name the model for the current head.

Without `--routing`, low-risk work still runs, but high-risk work fails closed: a high-risk diff with no configured cross-check model is a genuine failure (`hold: false`), and a safety-file change with no configured cross-check model stays a resumable hold (`hold: true`) with a clear reason. Gate records store gate outcomes, not model names.

## Reviewer second pass (Gate 2) triggers

Gate 1 (one review by the `reviewer` role) runs for every change. The second pass runs **only when the diff hits a trigger**; a diff with no trigger gets Gate 1 alone. There are two checks, and the second pass runs if either reports a reason:

- Host (`host/bin/rt-risk <wt> origin/<base> <issue-title>`, prints one reason line or nothing). A reason is printed when a changed path is under `scripts/`, `.github/`, `runtime/`, `.agents/skills/`, or `profiles/`, or any path has a `templates/` component; a changed file name contains `auth`, `secret`, `credential`, `token`, `deploy`, `network`, `proxy`, `webhook`, or `intake` (case-insensitive); the diff exceeds 400 changed lines (added + deleted); or the issue title contains `I18N`.
- Runtime (`gate2Triggers` in `runtime/lib/gate2-triggers.mjs`, returns reason names). Reasons: `translation` (i18n/locale/translation folders, `.po`/`.xliff`, or per-language `name.zh.md`-style files), `protocol` (verdict, classify, decide, and review-ledger modules, and the skill templates/prompts directories), `security` (the security trigger set below), and `thin-rationale` (the Gate 1 rationale is shorter than 40 characters).

## Security trigger set

The `security` role runs its Gate 2 pass only when a changed path matches the trigger set in `runtime/lib/security-triggers.mjs`. A path matches when one of its tokens (split on `/`, `.`, `_`, `-`, case-insensitive) is in the set. Any match adds the reason `security` to `gate2Triggers`; no match adds nothing.

- auth: `auth`, `oauth`, `login`, `session`, `password`, `rbac`, `permission(s)`
- network: `network`, `http`, `https`, `socket`, `proxy`, `webhook`, `listener`
- secrets: `secret(s)`, `credential(s)`, `token(s)`, `env` (e.g. `.env`), `key(s)`, `pem`
- external input: `intake`, `ingest`, `inbox`, `parse`, `parser`, `input(s)`
- deployment: `deploy`, `deployment`, `docker`, `dockerfile`, `systemd`, `launchd`

Tickets whose changes match none of these skip the security pass.

## Checks

```text
node --test test/runtime/routing.test.mjs
node --test test/runtime/gates.test.mjs
```
