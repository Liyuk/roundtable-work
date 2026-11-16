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

Import of the live loop scripts, prompts, policy and fake-gh/fake-model harness into `host/` is pending (owner action); until then `host/` contains only the deploy tool and its tests.
