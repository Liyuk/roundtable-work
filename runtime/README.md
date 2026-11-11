# runtime/

Deterministic Gate 0 acceptance checks (issue #28). No model, no network.

- `lib/accept.mjs` - `runGate0({ root, baseRef, issue, metadata, ... })` and a CLI.
- `lib/hygiene.mjs` - host / secret hygiene scan used by Gate 0 (rules 5-6).

Gate 0 can only reject or block a delivery. A `pass` is necessary but not sufficient for approval.

## CLI

```
node runtime/lib/accept.mjs --root <repo> --base <ref> --issue <issue.json> [--metadata <meta.json>] [--host-run --network-isolated]
```

Exit code 0 = pass, 1 = reject, 2 = block. Output is JSON with rule IDs, paths and line numbers only;
matched text is never printed (a length and a hash prefix are reported instead).

`issue.json`: `{ "allowedPaths": [...globs], "allowChanges": { "gate0": false, "verdict": false, "allowlists": false, "packageJson": false, "lockfiles": false, "ci": false, "tests": false, "symlinks": false, "submodules": false, "binaries": false }, "allowSkip": false }`.

## Base-side inputs

The diff under review can never widen what it is checked against. Everything below is read from the merge base:

- `package.json` (the test command and the Node `engines` pin),
- `.agents/skills/roundtable-work/templates/*.md` (field labels and placeholders for the frozen-token registry),
- `runtime/gate0-baseline.json` (optional): `{ "cjkPathAllowlist": [...globs], "testFakes": [{ "path", "hash" }], "frozenTokens": [...] }`.

## Host denylist

The production hostname / username denylist lives outside the repository at `$RT_HOME/gate0/denylist.json`
and must never be committed. On a host run (`--host-run`) a missing, unreadable or empty denylist is a block,
and so is a missing `--network-isolated` assertion (run Gate 0 in a network-less namespace; pure Node cannot sandbox the network).
Repository tests inject a fixture denylist with obviously fake names.

## Host-run inputs and fail-closed behavior

- On a host run (`--host-run`) the PR title, PR body and branch name must be supplied through `--metadata`
  (`{ "prTitle", "prBody", "branch" }`, each a string). An absent or non-string field is a block (`G0-METADATA`)
  so that PR metadata is never silently left unscanned. Without `--host-run` the behavior is unchanged.
- `--timeout-ms` (default 600000) is an overall deadline. It is checked between steps and during the hygiene scan,
  and a run that finishes after the deadline is a block (`G0-TIMEOUT`), never a pass. Every hygiene detector is
  linear in the line length, so a very long single line (minified JSON, a data URI) is scanned in full.
- Default test runner: only the base `package.json` is restored over the checked-out HEAD; lockfiles and CI config
  are not restored. Dependencies must be supplied by the host as `--deps-dir`.

