# Role-to-Model Routing

Status: implemented in `runtime/lib/routing.mjs` and wired through `runtime/rtd.mjs`.

A deployment routes each role to a harness, a model, and a model tier through one table. Role prompts do not name or ban models; the runtime appends a `Routing for this run` facts block to the rendered role prompt instead.

## Roles and tiers

The table must define exactly these roles:

`chief`, `developer`, `fixer`, `reviewer`, `researcher`, `crosscheck`

Tiers are ordered low to high: `economy`, `standard`, `strong`. A window's `reviewer` and `fixer` must be at least the `developer` tier, so review and repair are never graded below implementation. The `crosscheck` role, used for Gate 2 and safety-file approval, has a minimum tier of `strong`.

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
        "developer": { "harness": "pi", "model": "model-dev", "tier": "standard" },
        "fixer": { "harness": "pi", "model": "model-fix", "tier": "standard" },
        "reviewer": { "harness": "pi", "model": "model-review-strong", "tier": "strong" },
        "researcher": { "harness": "pi", "model": "model-research", "tier": "standard" },
        "crosscheck": { "harness": "pi", "model": "model-crosscheck", "tier": "strong" }
      }
    }
  ]
}
```

`model-dev`, `model-review-strong`, and the other ids above are illustrative, obviously fake names; deployments replace them with locally probed ids and must not treat the examples as available models.

Validation (`validateRouting`) rejects: a version other than 1; empty, duplicate-id, unsorted, overlapping, or invalid-timestamp windows; a missing or unknown role, naming the window and role; an empty `harness` or `model`; an unknown tier; a `reviewer` or `fixer` tier below `developer`; and a `crosscheck` tier below `strong`, naming the window and role. A valid table is returned unchanged; the runtime invents no defaults.

## Active window and prompt injection

For a run, `activeWindow(config, now)` selects the window where `from <= now < to`. If no window covers `now`, it throws a `RoutingError` (`code: 'ROUTING_INVALID'`, message prefixed `routing `). `routingFacts(config, now)` returns `{ window: <id>, roles: { <role>: { harness, model, tier } } }`.

`formatRoutingFacts(facts)` renders a Markdown block that starts with `## Routing for this run` and lists one line per role:

```text
- reviewer: harness=pi model=model-review-strong tier=strong
```

The block states that a receipt naming the routed model for its role is expected and allowed, and that only a model absent from the block is a configuration error to report and continue around. `renderRolePrompt(promptText, facts)` appends this block after the role prompt, so the facts are part of the assembled context. The block is the only routing source in prompts; it replaces hard-coded model names and one-tier-for-all wording.

## Gate models and fail-closed behavior

`rtd.mjs --routing FILE` loads and validates the table at startup, before any queue read, lock, or pass. A missing or invalid table prints the `routing ...` error and exits `2`. A valid table supplies `models.reviewer` and `models.crossCheck` to every `runGates` call in the pass.

- Gate 1 (review) receives `models.reviewer`.
- Gate 2 (high-risk cross-check) receives `models.crossCheck`.
- Safety-file approval must name `models.crossCheck` for the current head.

Without `--routing`, low-risk work still runs, but high-risk work fails closed: a high-risk diff with no configured cross-check model is a genuine failure (`hold: false`), and a safety-file change with no configured cross-check model stays a resumable hold (`hold: true`) with a clear reason. Gate records store gate outcomes, not model names.

## Checks

```text
node --test test/runtime/routing.test.mjs
node --test test/runtime/gates.test.mjs
```
