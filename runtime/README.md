# runtime/

Deterministic Gate 0 acceptance checks (issue #28). No model, no network.

- `lib/accept.mjs` - `runGate0({ root, baseRef, issue, metadata, ... })` and a CLI.
- `lib/hygiene.mjs` - host / secret hygiene scan used by Gate 0 (rules 5-6).

Gate 0 can only reject or block a delivery. A `pass` is necessary but not sufficient for approval.

## CLI

```
node runtime/lib/accept.mjs --root <repo> --base <ref> --issue <issue.json> --metadata <meta.json> --network-isolated [--deps-dir <dir>]
node runtime/lib/accept.mjs --root <repo> --base <ref> --issue <issue.json> --local
```

**The CLI default is production (host-run) semantics.** Without `--local` the run needs all of: a host denylist
under `$RT_HOME`, the `--network-isolated` assertion, and PR metadata (`--metadata`). A missing item is a block (exit 2).
`--host-run` is accepted and means the same as the default.

`--local` (alias `--no-host-run`) is the explicit opt-out for local experiments and tests. It is **non-authoritative**:
it may run the submitted tests with network access and without a denylist, PR metadata is optional, and the JSON output
carries `"mode": "local", "authoritative": false`. Never use a local result as a gate result.

Exit code 0 = pass, 1 = reject, 2 = block. Output is JSON with rule IDs, paths and line numbers only;
matched text is never printed (a length and a hash prefix are reported instead).

`issue.json`: `{ "allowedPaths": [...globs], "allowChanges": { "gate0": false, "verdict": false, "allowlists": false, "packageJson": false, "lockfiles": false, "ci": false, "tests": false, "symlinks": false, "submodules": false, "binaries": false }, "allowSkip": false }`.

## Base-side inputs

The diff under review can never widen what it is checked against. Everything below is read from the merge base:

- `package.json` (the test command and the Node `engines` pin),
- `.agents/skills/roundtable-work/templates/*.md` (every `- label:` / `- label (...)` bullet under any heading, and every
  `<...>` placeholder, feed the frozen-token registry; `baseline.frozenTokens` and a short built-in list of machine field
  names are added on top),
- `.agents/skills/roundtable-work/prompts/shared.md` (backticked machine words in the status-vocabulary section),
- the base lockfile (`package-lock.json`, or `npm-shrinkwrap.json`), compared with the supplied dependency directory,
- `runtime/gate0-baseline.json` (optional): `{ "cjkPathAllowlist": [...globs], "testFakes": [{ "path", "hash" }], "frozenTokens": [...] }`. The CJK path allowlist exempts only the added-line CJK check; the per-file CJK balance check applies to every file.

## Supplied metadata is additive

In git mode Gate 0 always reads the real commit messages and the author and committer identities of
`merge-base..HEAD` from git. Values given through `--metadata` (`commitMessages`, `authors`) are scanned in addition to
them, never instead of them, so a clean supplied list cannot hide a real commit message. Malformed values are a block.

## Host denylist

The production hostname / username denylist lives outside the repository at `$RT_HOME/gate0/denylist.json`
and must never be committed. On a host run (`--host-run`) a missing, unreadable or empty denylist is a block
(every path in the findings is then redacted to `<redacted:LEN:HASH8>`), and so is a missing `--network-isolated` assertion (run Gate 0 in a network-less namespace; pure Node cannot sandbox the network).
Repository tests inject a fixture denylist with obviously fake names.

## Host-run inputs and fail-closed behavior

- On a host run (`--host-run`) the PR title, PR body and branch name must be supplied through `--metadata`
  (`{ "prTitle", "prBody", "branch" }`, each a string). An absent or non-string field is a block (`G0-METADATA`)
  so that PR metadata is never silently left unscanned. Without `--host-run` the behavior is unchanged.
- `--timeout-ms` (default 600000) is an overall deadline. It is checked between steps and during the hygiene scan,
  and a run that finishes after the deadline is a block (`G0-TIMEOUT`), never a pass. Every hygiene detector is
  linear in the line length, so a very long single line (minified JSON, a data URI) is scanned in full.
- Default test runner: only the base `package.json` is restored over the checked-out HEAD; lockfiles and CI config
  are not restored. Dependencies must be supplied by the host as `--deps-dir`, and that directory must carry the
  lockfile it was installed from as `<deps-dir>/package-lock.json`. Its sha256 must equal the base lockfile; a missing
  or different copy is a block (`G0-DEPS`). The check applies when the base declares dependencies or has a lockfile.

## Static counting limitations

- Test-case counting is static: comments and the contents of string, template and regex literals are stripped, then
  `test(` / `it(` calls are counted in base and head. Commenting out a test lowers the count. It is a heuristic scanner,
  not a parser, and it does not execute code; the base test command is the authority on what actually runs.
- Disable markers (skip, only, pending and todo forms) are matched on the added lines of every non-Markdown file, test
  file or not. In Markdown only the dotted call forms are matched, so prose that uses the plain words is not rejected.
  A prose use of those words in a source comment can be a false reject; the issue may allow it explicitly.
- Frozen English tokens such as `done` or `review` are ordinary words: the per-file count must not drop, so rewording
  prose that contains them can be a false reject. Chinese tokens are counted only when not adjacent to another Han
  character. The registry is conservative and is not a proof that every machine field is covered.

