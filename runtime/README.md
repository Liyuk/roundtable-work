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

Exit code 0 = pass, 1 = reject, 2 = block. Any crash, unparsable input or internal error is a block (exit 2,
rule ID `G0-INTERNAL` or `G0-INPUT`), never a reject and never a raw error text. Output is JSON with rule IDs, paths and line numbers only;
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
  In git mode this file is read from the merge base only; a caller-supplied baseline is ignored (an injected baseline is for the pre-parsed-diff unit fixtures only).

## Supplied metadata is additive

In git mode Gate 0 always reads the real commit messages and the author and committer identities of
`merge-base..HEAD` from git. Values given through `--metadata` (`commitMessages`, `authors`) are scanned in addition to
them, never instead of them, so a clean supplied list cannot hide a real commit message. Malformed values are a block.

## Host denylist

The production hostname / username denylist lives outside the repository at `$RT_HOME/gate0/denylist.json`
and must never be committed. On a host run (`--host-run`) a missing, unreadable or empty denylist is a block
(every path in the findings is then redacted to `<redacted:LEN:HASH8>`), and so is a missing `--network-isolated` assertion (run Gate 0 in a network-less namespace; pure Node cannot sandbox the network).
A host run never honors an injected fixture denylist: the production file is always read, so a missing one fails closed.
Repository tests inject a fixture denylist with obviously fake names only on non-host runs; host-run tests point `RT_HOME` at a temp dir holding a fixture file.
Letters-only IPv6 candidates (such as a short mixed-case pair joined by two colons) are flagged everywhere except as a scope-resolution path in a code file outside any host context (ssh / scp / bracketed / `user@` / address words).

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
- The submitted tests are never run when the diff carries a symlink, a submodule, a binary or a path outside the
  allowed scope: the findings stand and the run is a block (`G0-TESTS-SKIPPED-SCOPE`). When tests do run, the runner
  removes whatever sits at each restored base file (a symlink included) and writes the file exclusively, so a
  submitted link is never followed out of the temporary work directory.
- Paths in findings are printed as is only when they are Gate 0's own fixed `<tests>` marker or were vetted by the
  hygiene scan; every other path, including one written in angle brackets, goes through the denylist scan first.

## Four-part version numbers (narrow exemption, H-53)

A four-part number is a version, not an address, only in two exact whole-line shapes. (1) A `version` key in a
manifest or lockfile (package.json, package-lock.json, npm-shrinkwrap.json, composer.json, composer.lock, any `*.lock`,
pyproject.toml, Cargo.toml, pubspec.yaml, Chart.yaml): JSON, TOML, YAML or lockfile form. (2) A `#` release heading in a
`.md`, `.markdown`, `.txt` or `.rst` file, such as a changelog entry with an optional `v`, brackets and a date.
A `v` or `@` prefix alone never exempts: prose, code, shell, YAML other than the named manifests, commit messages, PR
text, branch names and paths are still scanned. A number in a private, CGNAT or link-local range is never exempt, and
only that one number on that one line is skipped. Trade-off: a plausible public address written in an exact `version`
key passes, because that key overwhelmingly holds a version. A five-or-more-part number is not an address.

## Static counting limitations

- Test-case counting is static: comments and the contents of string, template and regex literals are stripped, then
  `test(` / `it(` calls and Node subtests (`t.test('name', ...)`, `t.it(...)`) are counted in base and head.
  Commenting out a test or deleting a subtest lowers the count. It is a heuristic scanner,
  not a parser, and it does not execute code; the base test command is the authority on what actually runs.
- Disable markers (skip, only, pending and todo forms) are matched on the added lines of every non-Markdown file, test
  file or not. In Markdown only the dotted call forms are matched (whitespace before the opening parenthesis included), so prose that uses the plain words is not rejected.
  A prose use of those words in a source comment can be a false reject; the issue may allow it explicitly.
- Frozen English tokens such as `done` or `review` are ordinary words: the per-file count must not drop, so rewording
  prose that contains them can be a false reject. Chinese tokens are counted only when not adjacent to another Han
  character. The registry is conservative and is not a proof that every machine field is covered.


## Threat-model decisions (issue #28)

- **Trusted copy.** Gate 0 must be run from a trusted copy of `runtime/` that lives outside the reviewed tree. A host
  run whose own file is inside `--root` is a block (`G0-SELF`). When the Gate 0 files themselves are in the diff the
  scope check rejects it unless `allowChanges.gate0` is set (the self-run of this change sets it).
- **No import from the reviewed tree.** The module imports node built-ins and `./hygiene.mjs` only. Verdict tokens and
  patterns are derived from the BASE text of `lib/verdict.mjs`, parsed as text and never executed. A base text that
  lacks a required form blocks (`G0-REGISTRY`).
- **Verdict first line.** The pattern is anchored at line start and end, fenced code is ignored, and every anchored
  line of a file on the base must still exist as its own line in the head file (a decoy elsewhere does not count).
- **New Markdown** gets the same direction, token, skip-marker (dotted call forms only; plain words stay allowed) and
  hygiene rules as any other added text. Zero-width, bidi and other format-control characters are rejected
  (`G0-INVISIBLE`) and stripped before every scan; escaped, entity, percent and base64 forms are decoded and scanned.
- **Git hardening.** Refs are validated and resolved once to SHAs; `--end-of-options`, `--` and `-z` are used; the
  config pins disable textconv, external diff, fsmonitor, hooks, attribute files and pagers; content is read from
  objects (`cat-file`), so `-diff` attributes cannot hide it. Binary files are scanned as extracted strings and
  symlink targets as text. Every commit in the range is scanned, so a value added and deleted in a middle commit is
  still found.
- **Dirty state.** A dirty worktree or any untracked file is a block (`G0-DIRTY`).
- **Test evidence.** The test runner reports the TAP counters. A passing exit code with no executed test, with skipped,
  todo or cancelled tests, or with a touched test file whose cases no longer execute is not a pass.
- **Exit codes.** 0 pass, 1 reject, 2 block (including every crash). All emitted strings are redacted: findings carry a
  rule ID, a path (hashed when it matches the denylist), a line, a length and a keyed hash only.
- **Deferred (host-side or contract-changing):** T-19, T-23, T-24, T-28, T-30, T-31, T-32, T-42, T-44, T-45 are tracked
  in the ledger and will become follow-up issues.
- **Deferred, critical (T-24):** submitted tests run as the same OS user as Gate 0, with filesystem access that pure Node
  cannot restrict. A host run therefore REQUIRES isolation provided by the host: a separate user, a container, or a
  read-only mount, in addition to the network assertion.
- **Deferred, high (T-30):** the installed dependency tree is trusted only through the lockfile copy check against the
  base lockfile; the code in it is not verified, and the `node_modules` link to the supplied directory is writable
  by the tests. Supply it from a read-only mount.
