# Host production

## Scope

- `host/` is the single production implementation of the live loop. Other implementations are not used for production.
- Under the rtd feature freeze: new `rtd` features are frozen. Bug fixes are allowed. Pure `rtd` modules may be called from the host loop as CLIs.

## Deploy tool (`host/deploy`)

Run `./host/deploy --dry-run` to print the steps without changing anything. A real run does the following:

1. Checks that main CI is green (`RT_HOST_CI_CMD`). It refuses otherwise.
2. Fetches `origin/main`; the version is its short SHA.
3. Extracts that commit into a versioned directory, `host/releases/<version>/`.
4. Runs the smoke suite (`RT_HOST_SMOKE_CMD`) in that directory. It refuses and removes the directory on failure.
5. Switches `host/releases/active` to the new version atomically (write temp file, then rename). The previous active version is recorded in `host/releases/previous`.
6. Polls `RT_HOST_HEARTBEAT_FILE` up to 2 times, each `RT_HOST_POLL_MS` apart. If no fresh heartbeat appears, it switches `active` back to the previous version and appends a `deploy-rollback` entry to `host/releases/ledger.jsonl`. If there is no previous version, nothing is rolled back.

`host/releases/` is git-ignored; it holds deploy output only.

## Status

- The import is done: the live-loop snapshot is at `host/` (scheduler `rt-sched.py`, worker `rt-work.sh`, helpers `bin/*`, `policy.md`, `status.sh`, `start-box.sh`). It is a snapshot, not yet re-synced with the live copy.
- `npm test` runs `host/test/smoke.test.mjs` with fake `gh`, `pi` and `codex` on PATH, a sandbox config from `config.env.example`, and no network. It covers the `rt-sched --dry-run --once` read-only check, `rt-agent --check`, the `rt-gate0 --scan-text` pass and fail cases, `status.sh` on an empty state, and one reviewer call through the fake `pi`.
- Gate 0 privacy scan (`host/bin/rt-gate0 --scan-text`) passes on every file under `host/` except `host/releases/`.
- Leftovers, not translated (this is an import; the I18N series owns it): the Chinese text in `host/README-v2.md` and some script strings.
