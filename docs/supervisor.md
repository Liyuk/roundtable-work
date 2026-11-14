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

## Grok Bot heartbeat liveness

The Grok Bot routine checks liveness from the heartbeat only: whether `writtenAt` is recent and `daemon.state` is `running`. It does not supervise, act on, or decide anything about the daemon.

## Auditor hook

`runCycle({ ..., auditor })` accepts an optional auditor with `name` (non-empty string) and `audit(input)` (function). `input` is a frozen copy of the GitHub read model `{ issues, pulls, checks, comments }`. The auditor returns an array of note strings; each note is recorded as an `observe-only` decision on the cycle's trace, with `findingSignature` `auditor:<name>`. The auditor is read-only evidence: it cannot call the actuator and cannot change any decision.

The auditor's model is chosen by the routing configuration (the `role → model` block that `rt-agent` writes for each run), not by the auditor code. Do not hard-code a model name in an auditor.
