# Chief session bridge

The owner's interactive session can read the daemon's status and send owner commands into the event inbox. It uses the same command shape as a GitHub `/rt` comment, so the daemon treats both sources the same way.

The bridge holds no state. Closing the session does not affect the daemon, and the daemon does not need a session to run.

## Commands

Run from the workspace root (or pass `--work-root DIR`, which must be a directory named `.roundtable`).

```
rtd.mjs chief status [--json]
rtd.mjs chief say <command...> [--repo OWNER/REPO]
```

`status` reads, and never writes:

- `running`: `true` only when the daemon heartbeat is fresh and its state is `running`.
- `pendingConfirmation`: actions in the action journal in state `executed_pending_confirmation`, with their `id`, `issue` and `kind`.
- `decisionCards`: suspended decision lines with a pending question, with `issue`, `category`, `question` and `recommendation`.

Without `--json`, `status` prints one line per item.

`say` validates the command with the same parser as GitHub `/rt` comments and appends it to the event inbox as an `owner_comment` event. The owner is the owner segment of `--repo` (or of `GITHUB_REPOSITORY`). If the owner cannot be determined, `say` fails and writes nothing. An invalid command also fails and writes nothing. A command already in the inbox is dropped by the inbox's duplicate check, and the output shows `"accepted": false`.

## Command set

- `confirm <action-id>`: confirms an executed action.
- `rollback <action-id>`: rolls back an action that has a revert recipe.
- `amend <action-id> <text>`: asks for an amendment to an executed action.
- `pause`, `resume`, `requeue`, `status`: the issue-level commands accepted from `/rt`.

`merge` is never accepted. Reprioritize and add-requirement are not implemented and cannot be sent.

## Event shape

A `say` command and a GitHub `/rt` comment produce the same event: kind `owner_comment`, the issue (the action's issue for action commands, otherwise none), and payload `{ body, author }` where `body` is `/rt <command>`. Only `source_event_id` differs: `chief-session:<hash>` here, `gh-comment:<id>` on GitHub. The hash is derived from the normalized command text, so repeating a command is idempotent.
