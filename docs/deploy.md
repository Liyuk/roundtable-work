# Running rtd 7x24

This guide explains how to keep the rtd daemon running all the time. It covers three targets:

- a cloud server (recommended), using a Linux systemd user unit;
- a macOS machine, using a launchd LaunchAgent;
- Docker, using `deploy/docker/compose.yaml`.

## Terminal multiplexers are not supervisors

Running rtd inside tmux or screen keeps it alive only while the session exists. A multiplexer does not
restart rtd after a crash, a reboot, or a logout. Use one of the supervisors below (systemd, launchd, or
Docker restart policy) for 7x24 operation. A multiplexer may still be useful for watching logs by hand.

## Common inputs

`rtd install` requires these options (all are paths or values you supply; do not commit them):

| Option | Meaning |
| --- | --- |
| `--workspace <dir>` | Workspace root; rtd state lives in `<dir>/.roundtable`. |
| `--env-path <file>` | Environment file read by the service. Keep secrets only here. |
| `--handler <file>` | Handler module passed to rtd. |
| `--providers <file>` | Providers module passed to rtd. |
| `--routing <file>` | Routing file passed to rtd. |
| `--alert-issue <ref>` | Issue used for alerts. |

Optional: `--unit-dir <dir>` overrides the default install directory, and `--dry-run` prints what would be
written without writing anything.

## Cloud server (recommended, Linux)

1. Install and sign in to the GitHub CLI and the harness CLIs for the user that will run rtd.
2. Preview the units:

   ```sh
   rtd install --dry-run --workspace <workspace> --env-path <env-file> \
     --handler <handler.mjs> --providers <providers.mjs> --routing <routing.json> \
     --alert-issue <issue>
   ```

3. Write the units. Without `--unit-dir`, they go to `$XDG_CONFIG_HOME/systemd/user`
   (or `~/.config/systemd/user`):

   ```sh
   rtd install --workspace <workspace> --env-path <env-file> \
     --handler <handler.mjs> --providers <providers.mjs> --routing <routing.json> \
     --alert-issue <issue>
   ```

   `rtd install` writes `rtd.service`, `rtd-watchdog.service`, `rtd-watchdog.timer`, and a manifest
   file. It refuses to overwrite existing unit files. It does not run the commands it prints.

4. Enable and start the units as printed by `rtd install`:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now rtd.service
   systemctl --user enable --now rtd-watchdog.timer
   ```

5. If rtd must keep running after the user logs out, enable lingering for that user with
   `loginctl enable-linger <user>`. `rtd install` does not do this.

The service uses `Restart=always`, so systemd restarts rtd after a crash. The unit has no `[Install]`
section, so it does not start automatically at boot; start it with the `enable --now` commands above.

## macOS (launchd)

1. Install and sign in to the GitHub CLI and the harness CLIs.
2. Preview the LaunchAgent with `rtd install --dry-run ...` using the same options as above.
3. Write it. By default the plist goes to `~/Library/LaunchAgents/io.roundtable.rtd.plist`:

   ```sh
   rtd install --workspace <workspace> --env-path <env-file> \
     --handler <handler.mjs> --providers <providers.mjs> --routing <routing.json> \
     --alert-issue <issue>
   ```

4. Load it as printed by `rtd install`:

   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.roundtable.rtd.plist
   ```

Notes:

- The LaunchAgent has `RunAtLoad` and `KeepAlive`, so launchd starts rtd at login and restarts it if it exits.
- launchd does not load the env file. Put non-secret variables under `EnvironmentVariables` in the plist yourself.
- The machine must not sleep while rtd runs (for example, run `caffeinate -i` or change the Energy settings).

## Docker

`deploy/docker/compose.yaml` defines one service, `rtd`. It runs `runtime/rtd.mjs` from the mounted
repository on `node:24-bookworm-slim`.

- `restart: unless-stopped` restarts the container after a crash or a host reboot, unless you stopped it
  yourself.
- The healthcheck runs `deploy/docker/healthcheck.mjs`. It passes only when the daemon heartbeat exists,
  parses, and is less than 120 seconds old.
- The repository is mounted read-only. Only `.roundtable` is writable.
- Secrets go in `deploy/docker/rtd.env`, which is optional and git-ignored.
- Handler, providers, and routing files are mounted from the directory set by `RTD_CONFIG_DIR` (default
  `./config`) at `/config`. The default container paths are `/config/handler.mjs`, `/config/providers.mjs`,
  and `/config/routing.json`; override them with `RTD_HANDLER`, `RTD_PROVIDERS`, and `RTD_ROUTING`.

Start it from the repository root:

```sh
docker compose -f deploy/docker/compose.yaml up -d
docker compose -f deploy/docker/compose.yaml ps
```

## Checking a running install

`rtd doctor` runs read-only checks and prints one `PASS` or `FAIL` line per check, each failure with a fix
hint:

```sh
rtd doctor --workspace <workspace> --repo <owner>/<repo>
```

It checks GitHub auth, the harness CLIs, repository access, the state directory, free disk space, the
service state (systemd or launchd), and heartbeat age. Options: `--json`, `--min-free-mb`, and
`--max-heartbeat-age-ms`. It exits 0 when all checks pass, 1 when any check fails, and 2 on bad options.

## Removing the units

`rtd uninstall` removes the unit files listed in the install manifest. Stop the service first:

```sh
systemctl --user disable --now rtd-watchdog.timer rtd.service    # Linux
launchctl bootout gui/$(id -u)/io.roundtable.rtd                  # macOS
rtd uninstall
```

`rtd uninstall` accepts `--unit-dir` if you installed with a custom directory. If there is no manifest in
that directory, it exits with an error and removes nothing.
