// Host stage runner: freeze-tolerant budgets, the one-retry rule, and chief-wake resume. No network; fake agents only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE_RUN = join(hostDir, 'bin', 'rt-stage-run');
const SKIP = new Set(['releases', 'test', 'deploy', 'config.env', 'state', 'logs', 'locks', 'status.tsv']);

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs rt-stage-run around a shell child. `script` is the child body; `clocks` are fake clock files.
function stage(t, { script, budget = 600, wall, uptime, poll = 1 }) {
  const dir = scratch(t);
  const env = { ...process.env, RT_STAGE_POLL: String(poll), RT_RETRY_BACKOFF: '0', CALLS: join(dir, 'calls') };
  delete env.RT_WALL_FILE; delete env.RT_UPTIME_FILE;
  if (wall !== undefined) { env.RT_WALL_FILE = join(dir, 'wall'); writeFileSync(env.RT_WALL_FILE, String(wall)); }
  if (uptime !== undefined) { env.RT_UPTIME_FILE = join(dir, 'uptime'); writeFileSync(env.RT_UPTIME_FILE, `${uptime} 1.00\n`); }
  env.WALL = env.RT_WALL_FILE;
  const child = join(dir, 'child.sh');
  writeFileSync(child, script);
  const log = join(dir, 'stage.log');
  const started = Date.now();
  const r = spawnSync(STAGE_RUN, ['chief', String(budget), log, 'bash', child], { env, encoding: 'utf8', timeout: 30_000 });
  const calls = existsSync(env.CALLS) ? readFileSync(env.CALLS, 'utf8').split('\n').filter(Boolean).length : 0;
  return { status: r.status, calls, ms: Date.now() - started, log: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('AC1: a 90-minute VM freeze (wall jumps, active clock still) causes no stage timeout and no retry', (t) => {
  const r = stage(t, {
    uptime: 5000,
    wall: 1_000_000,
    script: 'echo x >>"$CALLS"; echo 1005400 >"$WALL"; sleep 2; exit 0',
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls, 1);
});

test('AC2: a genuinely hung stage (both clocks advance) is killed at its budget and returns 124', (t) => {
  const r = stage(t, { budget: 2, script: 'echo x >>"$CALLS"; sleep 60', poll: 1 });
  assert.equal(r.status, 124);
  assert.ok(r.ms < 15_000, `took ${r.ms} ms`);
});

test('AC4: a provider error after a gap is retried exactly once and the second success returns 0', (t) => {
  const r = stage(t, {
    uptime: 5000,
    wall: 1_000_000,
    script: `echo x >>"$CALLS"
if [ "$(wc -l <"$CALLS")" -eq 1 ]; then echo "error: api_error from provider"; echo 1005400 >"$WALL"; exit 1; fi
exit 0`,
  });
  assert.equal(r.status, 0);
  assert.equal(r.calls, 2);
});

test('AC4: after a gap, a second provider error fails the stage with its rc and exactly two invocations', (t) => {
  const r = stage(t, {
    uptime: 5000,
    wall: 1_000_000,
    script: 'echo x >>"$CALLS"; echo "fetch failed"; echo 1005400 >"$WALL"; exit 3',
  });
  assert.equal(r.status, 3);
  assert.equal(r.calls, 2);
});

test('AC4: a provider error without a gap is not retried', (t) => {
  const r = stage(t, {
    uptime: 5000,
    wall: 1_000_000,
    script: 'echo x >>"$CALLS"; echo "ECONNRESET"; exit 1',
  });
  assert.equal(r.status, 1);
  assert.equal(r.calls, 1);
});

// ---- AC3: a worker killed during chief wake N resumes that wake on restart without spending budget ----

const FAKE_GH = `#!/usr/bin/env bash
echo "$1 $2" >> "$FAKE_GH_LOG"
case "$2" in list) echo '[]';; view) echo '{}';; esac
`;
// Fake agent (replaces bin/rt-agent): reports harness/model; a chief call logs its log name and the status line the worker
// set just before it (wake + budget), then stops the loop.
const FAKE_AGENT = `#!/usr/bin/env bash
case "$1" in --harness) echo pi;; --model) echo tokenarmy/fake;; chief) cat >/dev/null; echo "$(basename "$3") $(grep -o 'chief wake [0-9]* (budget [0-9]*/' "$RT_HOME/status.tsv")" >>"$RT_HOME/chief-calls.log"; touch "$RT_HOME/STOP";; esac
`;

// Sets up a copy of the host under a scratch RT_HOME with a fake gh and agent, and runs rt-work.sh for issue 521.
function runWorker(t, { checkpoint, agent = FAKE_AGENT }) {
  const dir = scratch(t);
  const root = join(dir, 'rt');
  mkdirSync(root);
  for (const name of readdirSync(hostDir)) {
    if (!SKIP.has(name)) cpSync(join(hostDir, name), join(root, name), { recursive: true });
  }
  cpSync(join(hostDir, 'config.env.example'), join(root, 'config.env'));
  writeFileSync(join(root, 'bin', 'rt-agent'), agent, { mode: 0o755 });
  const fakebin = join(dir, 'fakebin');
  mkdirSync(fakebin);
  writeFileSync(join(fakebin, 'gh'), FAKE_GH, { mode: 0o755 });
  // Existing worker worktree (rt-wt reuses it) with the checkpoint a killed worker leaves.
  const sd = join(root, 'wt', '521', '.roundtable', 'state');
  mkdirSync(sd, { recursive: true });
  const cp = join(sd, 'chief-stage');
  if (checkpoint) writeFileSync(cp, checkpoint);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RT_|GH_|GITHUB_)/.test(k)));
  const env = {
    ...inherited,
    PATH: `${fakebin}:${process.env.PATH}`,
    RT_HOME: root,
    RT_GH_REAL: join(fakebin, 'gh'),
    RT_REPO_DIR: root,
    FAKE_GH_LOG: join(dir, 'gh.log'),
  };
  const r = spawnSync('bash', [join(root, 'rt-work.sh'), '521'], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  return { r, root, cp };
}

test('AC3: a worker killed during chief wake 3 resumes wake 3 on restart without incrementing the wake budget', (t) => {
  const { r, root } = runWorker(t, { checkpoint: 'chief 3 2\n' });
  assert.equal(r.status, 0, r.stderr);
  const calls = readFileSync(join(root, 'chief-calls.log'), 'utf8').trim().split('\n');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /-wake3-\S+ chief wake 3 \(budget 2\//);
});

test('AC3: a chief wake that ends without a DECISION clears chief-stage so a restart cannot replay it', (t) => {
  const { r, cp } = runWorker(t, { checkpoint: 'chief 3 2\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(cp), false);
});

test('AC1: every budgeted stage (decider, threat, opus-fix, exploit, CI watch) runs under rt-stage-run, not a wall-clock timeout', () => {
  const rtWork = readFileSync(join(hostDir, 'rt-work.sh'), 'utf8');
  const decide = readFileSync(join(hostDir, 'bin', 'rt-decide'), 'utf8');
  for (const stage of ['threat', 'opus-fix', 'exploit', 'ci-watch']) assert.match(rtWork, new RegExp(`rt-stage-run"? ${stage} `));
  assert.match(decide, /rt-stage-run"? decider /);
  assert.doesNotMatch(rtWork + decide, /timeout --kill-after=\d+ "?(\$\{?RT_|\$CI_TMO|\$TMO)/);
});
