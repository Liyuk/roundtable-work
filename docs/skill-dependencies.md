# Skill dependencies

Status: the manifest, startup doctor check, and license gate are implemented. Every upstream pin is still `null` (no real commit has been resolved), so the doctor reports the fallback for every required skill until a pin is recorded.

## What is pinned, and what is not

Roundtable Work does not vendor upstream skill trees. [`practice/skills/manifest.json`](../practice/skills/manifest.json) lists the skills the team relies on. Each entry has:

| Field | Meaning |
| --- | --- |
| `id` | Directory name the skill is installed under (also the short name used by the doctor). |
| `name` | Human-readable short name. |
| `requirement` | `required` or `optional`. |
| `roles` | Roles that may load the skill. |
| `source` | `{ repo, path }`: the public upstream repository URL and the skill directory inside it (`path: null` means the repository root). `null` if the entry's upstream is not named in issue #552; its `note` says why. |
| `pin` | A full 40-character commit SHA, or `null`. Never a branch name. |
| `checksum` | `sha256:` digest of the skill directory at that pin, or `null`. |
| `fallback` | `distilled-core` for required skills; `skip` for optional skills. |

An entry with `pin: null` is never installed. The doctor reports it and uses the fallback. The in-repo fallback texts for required skills live in [`practice/fallback/`](../practice/fallback/), named by each entry's `fallbackFile`.

## Standard skill directories

The doctor looks for each skill under the workspace in `.agents/skills/<id>/` or `.claude/skills/<id>/` (relative to the workspace, never a home directory). Installs go to `.agents/skills/`.

## What the doctor does

`node scripts/doctor.mjs --target <workspace>` checks each entry (read-only, unless the user consents):

- **Present and verified at pin:** the copy's `.rt-pin` file equals the manifest pin and its tree checksum equals the manifest checksum. The loop continues normally.
- **Optional and absent:** ignored.
- **Required and missing:** a pinned install is offered only when consent is available, meaning an interactive terminal on both stdin and stdout. Refusal, install failure, or an unattended session (no terminal) leaves the loop running and the report says fallback will be used. The doctor exits 0 for these cases.
- **Present but refused** (pin mismatch, checksum mismatch, or no pin): that copy is not used. A required skill falls back. The doctor never offers to overwrite a refused copy.

## License gate

Before any copy, the installer reads the `LICENSE` file at the pinned commit and records the result in `<workspace>/.roundtable/skill-licenses.json` (the license is `null` if missing or not recognized). Install proceeds only for an allowed license: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, or ISC. A missing or incompatible license refuses the install, and the loop continues on fallback.

## Unattended fallback rule

With no terminal consent, nothing is installed and nothing is fetched. The report lists each required skill's status and states that the fallback will be used. Work continues on the in-repo fallback; the doctor does not exit non-zero for this.

## Updating a pin

1. In a clone of the upstream repository, confirm `source.path` and resolve the commit you want with a real command (for example `git rev-parse <tag>`). Do not copy a SHA from another source without checking it.
2. Check out that commit and read its `LICENSE`; confirm the license is in the allowed list.
3. Compute the checksum of the skill directory at that commit:
   `node --input-type=module -e "import('./scripts/skill-deps.mjs').then(m => m.treeChecksum(process.argv[1])).then(console.log)" <skill-dir>`
4. Set `source`, `pin`, and `checksum` in the manifest entry, then run `npm test`.

Tests never fetch from the network and never install a skill: the fetch and consent functions are injected in the tests.
