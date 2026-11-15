# Supervisor heartbeat (read side)

The supervisor watches two things: the daemon and the front Chief session. Both report through one heartbeat file. This document covers the heartbeat schema, the parser and writer, the read-only collector, the observe-only entrypoint and its systemd unit template. Watchdog rules, ledger and actuator internals are out of scope here.

Code: [heartbeat.mjs](../runtime/supervisor/heartbeat.mjs) (schema, `parseHeartbeat`, `writeHeartbeat`), [collect.mjs](../runtime/supervisor/collect.mjs) (`collect`), [supervise.mjs](../runtime/supervise.mjs) (entrypoint: `runCycle`, `parseArgs`, `main`) and [rt-supervisor.service](../deploy/systemd/rt-supervisor.service) (unit template).

## Heartbeat path

`<workspace>/.roundtable/state/heartbeat.json` (`HEARTBEAT_PATH` in `heartbeat.mjs`, relative to the workspace root). The file is replaced whole on each write.

## Schema

All timestamps are epoch milliseconds (numbers). `schemaVersion` must be `1`.

```json
{
  "schemaVersion": 1,
  "writtenAt": 1000,
  "daemon": { "pid": 4242, "lastCycleAt": 900, "state": "running" },
  "frontChief": { "session": "front-chief", "lastTurnAt": 950, "state": "active" },
  "lastMaterialProgress": { "kind": "commit", "at": 800, "ref": "abc1234" }
}
```

| Field | Type | Allowed values |
| --- | --- | --- |
| `schemaVersion` | number | `1` |
| `writtenAt` | number | when the heartbeat was written |
| `daemon.pid` | integer | daemon process id |
| `daemon.lastCycleAt` | number | end of the last daemon cycle |
| `daemon.state` | string | `running`, `stopping`, `stopped` |
| `frontChief.session` | string | front Chief session name |
| `frontChief.lastTurnAt` | number | end of the last front Chief turn |
| `frontChief.state` | string | `active`, `idle`, `gone` |
| `lastMaterialProgress` | object or `null` | `null` when no progress has been recorded yet |
| `lastMaterialProgress.kind` | string | `commit`, `verdict`, `pr` (any other value is rejected) |
| `lastMaterialProgress.at` | number | when the progress happened |
| `lastMaterialProgress.ref` | string | commit SHA, verdict id or PR number reference |

## Parser result

`parseHeartbeat(text)` never throws. It returns one of:

- `{ ok: true, value }`: valid; `value` is the heartbeat object.
- `{ ok: false, reason: 'missing' }`: no file content (`undefined` or `null`).
- `{ ok: false, reason: 'malformed', error }`: the text is not JSON; `error` is the parser message.
- `{ ok: false, reason: 'invalid-schema', field }`: JSON that breaks the schema above; `field` names the first failing part (`schemaVersion`, `writtenAt`, `daemon`, `frontChief`, `lastMaterialProgress`).

## Writer

`writeHeartbeat(hb, { write })` validates `hb` against the same schema (throws `invalid heartbeat` otherwise), then calls `write(HEARTBEAT_PATH, text)` with the caller's write function. The writer does no I/O of its own.

## Read-only collector

`collect({ now, issue, readHeartbeat, readDaemonState, readDaemonLog, github })` returns a snapshot:

- `heartbeat`: the parser result for the text returned by `readHeartbeat()`.
- `daemon`: `{ state, log }` from `readDaemonState()` and `readDaemonLog()`.
- `github`: `{ issues, pulls, checks, comments }`. `checks` maps each PR number to its checks.
- `sinceLastMaterialProgressMs`: `now - lastMaterialProgress.at`, or `null` when the heartbeat is missing, malformed, or has no progress.

The `github` client is injected and may only offer read methods: `listIssues()`, `listPulls()`, `listChecks(headSha)`, `listComments(issue)`. The collector calls nothing else and does no file or network writes.

## Grok Bot liveness

A Grok Bot routine may read the heartbeat file to check liveness (is `writtenAt` recent, is `daemon.state` `running`). It has no control API: it cannot start, stop, or message the daemon or the front Chief session.

## Entrypoint and modes

`node runtime/supervise.mjs --workspace <workspace> --github-fixture <file> [--mode observe] [--issue <n>]`

- `--mode` is `observe` by default. `observe` records decisions in the ledger and never acts.
- `--mode apply` exits non-zero with `apply needs live actuator adapters, which this entrypoint does not wire`. Live actuator adapters are not part of this entrypoint, so apply exists only as `runCycle({ mode: 'apply', actuator })` with an injected actuator.
- `--github-fixture <file>` is required. It is a JSON file `{ issues, pulls, checks, comments }`, where `checks` maps a head SHA to its checks. No live GitHub client is wired; the fixture is the only GitHub source and the entrypoint makes no network call.
- Each run performs one cycle: collect the snapshot, run the watchdog, then write a cycle root record and one decision per finding. Every decision has the root as `parentId` and shares its `traceId`. The only file written is `<workspace>/.roundtable/state/supervisor-ledger.jsonl`. The run prints the result as one JSON line (`traceId`, `rootId`, `mode`, `findings`, `decisions`).
- The daemon is observed only through the heartbeat file. `daemon.state` and `daemon.log` are `null` in the snapshot.

## Identity and tokens

The daemon and the supervisor run as separate OS users, each with its own token. Neither token is exposed to child runtimes (the Chief, worker or reviewer sessions the daemon starts). Token files are referenced through the unit's `EnvironmentFile`, never committed. Creating the users and tokens is an owner action. Issue #39 is retired and must not be used as the source of supervisor credentials.

## Unit template

[rt-supervisor.service](../deploy/systemd/rt-supervisor.service) is a `Type=oneshot` template that runs the observe-mode entrypoint. It is a template only: it is not enabled, installed, or referenced by any script. Before installing, replace every `<placeholder>` (`<supervisor-user>`, `<workspace>`, `<env-file>`). The unit contains no host paths, addresses or secrets.

The daemon has a matching template, [rtd.service](../deploy/systemd/rtd.service) (`Type=simple`, `Restart=on-failure`, its own `<daemon-user>`, same `<env-file>` convention). It is also template only, has no `[Install]` section, and is not enabled or installed.

## Grok Bot heartbeat liveness

The Grok Bot routine checks liveness from the heartbeat only: whether `writtenAt` is recent and `daemon.state` is `running`. It does not supervise, act on, or decide anything about the daemon.

## Auditor hook

`runCycle({ ..., auditor })` accepts an optional auditor with `name` (non-empty string) and `audit(input)` (function). `input` is a frozen copy of the GitHub read model `{ issues, pulls, checks, comments }`. The auditor returns an array of note strings; each note is recorded as an `observe-only` decision on the cycle's trace, with `findingSignature` `auditor:<name>`. The auditor is read-only evidence: it cannot call the actuator and cannot change any decision.

The auditor's model is chosen by the routing configuration (the `role → model` block that `rt-agent` writes for each run), not by the auditor code. Do not hard-code a model name in an auditor.

## Observer mode

Stage S5 of the staged plan in [self-supervision.md](self-supervision.md) (section (g)) is observer mode. It is reached when the S4 measures hold. In S5 the external assistant only reads the heartbeat, the intervention ledger and GitHub, and records any intervention it would have made. Its actuator and write access are removed.

Code: [stage.mjs](../runtime/lib/stage.mjs) (`stage`, `exitConditions`, `observerAllows`), [rt-stage.mjs](../scripts/rt-stage.mjs) (CLI), [observer.json](../runtime/defaults/observer.json) (the data file).

- **Allowed operations** (`allowed` in `observer.json`): `read-heartbeat`, `read-ledger`, `read-github`, `record-intervention`.
- **Denied**: every action in `ALLOWED_ACTIONS` of [actuator.mjs](../runtime/supervisor/actuator.mjs) (`restart-daemon`, `pause-queue`, `void-stale-pause`, `reprompt`, `rollback`, `add-label`, `convert-to-draft`). `observerAllows(action)` returns `false` for these and for any unknown name, so the check fails closed.
- **Final exit**: `node scripts/rt-stage.mjs --workspace DIR --exit` exits 0 only when all five conditions hold over the last `exit.windowHours`. It prints one line per condition (`condition=<name> ok|fail value=<n>`) and then `exit: pass|fail`.
- **Owner steps** (never automated; see section (g) of [self-supervision.md](self-supervision.md)): reboot the host; change proxy, SSH, firewall or network configuration; install system packages or binaries; create OS users, tokens or credentials; delete data (state, worktrees, branches, history); stop or reconfigure other services on the host; install or enable units; run the `--live` cutover and rollback. These are recorded as `owner-only` and do not count toward the exit.

## Signal loop

Code: [signals.mjs](../runtime/supervisor/signals.mjs). It is pure (no fs, network or clock reads; `now` is passed in), uses no LLM, and is **observe-only**: it is not wired into the supervisor entrypoint and does not act on any task.

Input is the task-row list from the ledger snapshot: `{ id, status, owner, checkpoint, askedAt, heartbeatAt, startError }`. Active statuses are `running`, `asking` and `pending-review`.

Six detectors, each exported and run by `detectSignals(tasks, now, config)`, in this order (`SIGNAL_KINDS`):

- `pending-review`: the row is `pending-review`.
- `stopped-midway`: the row is `stopped` and has a checkpoint.
- `ask-timeout`: the row is `asking` and has waited `askTimeoutMs` (default 2 hours).
- `stalled`: the row is `running` and its heartbeat is at least `stallMs` old (default 30 minutes).
- `start-failed`: the row has a `startError`.
- `orphaned`: the row is active and has no owner.

Each finding is `{ kind, signature, taskId, evidence }` with `signature = kind:taskId`. The signature keys on the condition, not on time.

`createSignalLoop({ windowMs, holdMs })` returns `cycle({ findings, now, ownerActiveAt })`, which returns `{ message, held }`:

- **Dedupe**: a signature already delivered and still active is never sent again. When a condition clears, it is forgotten, so a reappearance is sent again.
- **Merge**: all pending signatures in one cycle go into one message, one line per signature (`kind taskId`), sorted by signature.
- **Rate limit**: the same set of pending signatures is delivered at most once per `windowMs` (default 30 minutes). Inside the window the signatures stay pending and are reported as `held`.
- **Hold**: while the owner was active within `holdMs` (default 10 minutes), nothing is sent and the signatures stay pending. `ownerActiveAt(comments, owner)` gives the owner's latest comment time from the snapshot (`{ author, at }`, or `null`).
