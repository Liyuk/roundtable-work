# Front Chief session

Purpose: one resumable front Chief session per workspace. Each start reads the task ledger, builds a capped
prompt from it, and launches the Chief session through a launcher. Single-flight: a second start while one is
running is refused.

## Files

- `runtime/lib/front-chief.mjs`: `buildStatus`, `renderPrompt`, `statusOf`, `startFrontChief`.
- `bin/rt-chief.mjs`: CLI (`main` is exported; the entry runs only when executed directly).
- `test/runtime/front-chief.test.mjs`: tests.

## Records

- `<workspace>/.roundtable/state/task-ledger.jsonl`: append-only input, one JSON record per line
  (`issue`, `state`, `line`, `decision`, `why`, `pr`, `at`). Invalid lines are counted, never fatal.
- `<workspace>/.roundtable/state/front-chief-session.json`: `{ sessionId, lastStartedAt }`, written by temp file
  and rename before the launch, so a killed session resumes the same id.
- Lock: `<workspace>/.roundtable/state/front-chief.lock.d`, held through `lib/lock.mjs` (its records live in the
  private anchor; the work root also gets the lock-domain marker that `lock.mjs` writes).

Nothing else is written. Logs and diffs are never read.

## Prompt

`renderPrompt` estimates tokens as `ceil(length / 4)` and keeps the prompt within `PROMPT_CAP_TOKENS` (4000).
Tasks are sorted by issue ascending; the highest issue numbers are omitted first, with a trailing line
`... N more open tasks omitted; run the status command for the full list`. A role prompt that alone exceeds the
cap throws `RangeError`.

## Launcher contract

`start` spawns the executable in `RT_AGENT_BIN` with args
`chief --front --session <id> --new|--resume`, cwd = workspace, and the prompt on stdin. Without `RT_AGENT_BIN`
it exits 2 with `no launcher configured: set RT_AGENT_BIN`.

Exit codes: 0 started, 3 already running, 1 other error, 2 no launcher.

`status --workspace <dir>` prints the status JSON and launches nothing.

## Not verified

- Behaviour of a real Chief launcher; the tests use a stub script.
- A lease refresh failure is swallowed in the renewal timer (`refresh()` returns false); the session keeps running
  without the lock. No abort on lost lease.
- Default role prompt is read from the repository copy of `roles/chief.md`, not from the workspace.
