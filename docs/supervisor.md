# Supervisor heartbeat (read side)

The supervisor watches two things: the daemon and the front Chief session. Both report through one heartbeat file. This document covers the heartbeat schema, the parser and writer, and the read-only collector. Watchdog rules, ledger, actuator, entrypoint and service units are out of scope here.

Code: [heartbeat.mjs](../runtime/supervisor/heartbeat.mjs) (schema, `parseHeartbeat`, `writeHeartbeat`) and [collect.mjs](../runtime/supervisor/collect.mjs) (`collect`).

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
