// --dry-run is a no-op: no worker/model process, no GitHub write, no local state write (only logs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const sched = join(dirname(fileURLToPath(import.meta.url)), '..', 'rt-sched.py');
const READ_VERBS = new Set(['issue list', 'issue view', 'pr list', 'pr view', 'label list', 'run list']);
const CLAIMABLE = [{ number: 7, state: 'OPEN', title: '[RT-1] dry-run probe', body: '', createdAt: '2026-01-01T00:00:00Z',
  labels: [{ name: 'type:bug' }], author: { login: 'owner' } }];

// Fake gh: logs argv, answers reads with fixed JSON, and returns {} for anything else.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "issue list") echo '${JSON.stringify(CLAIMABLE)}';;
  "issue view") echo '{}';;
  "pr list"|"run list"|"label list") echo '[]';;
  *) echo '{}';;
esac
`;
// Fake worker: if it is ever spawned, it leaves a marker in RT_HOME.
const FAKE_WORK = `#!/usr/bin/env bash\ntouch "$RT_HOME/SPAWNED"\n`;

// Every file and dir under `root` (relative path -> content), skipping the fake-gh fixtures and the logs.
function snapshot(root) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const rel = relative(root, p);
      if (rel === 'fx' || rel === join('rt', 'logs')) continue;
      if (e.isDirectory()) { out[rel + '/'] = ''; walk(p); }
      else out[rel] = readFileSync(p, 'utf8');
    }
  };
  walk(root);
  return out;
}

// Sandbox: box/rt = RT_HOME, box/fx = fake gh + log, box/tmp = TMPDIR, box/statedir = RTW_STATE_DIR.
function runSched(t, { dry }) {
  const box = mkdtempSync(join(tmpdir(), 'rt-dryrun-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const home = join(box, 'rt'), fx = join(box, 'fx'), tmp = join(box, 'tmp'), statedir = join(box, 'statedir');
  for (const d of [home, fx, tmp]) mkdirSync(d);
  writeFileSync(join(fx, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(home, 'rt-work.sh'), FAKE_WORK, { mode: 0o755 });
  // Resource thresholds disabled so the claim path is reachable on any host.
  writeFileSync(join(home, 'config.env'), 'RT_REPO=example/repo\nRT_OWNER=owner\nRT_WORKERS=1\n' +
    'RT_MAX_LOAD=100000\nRT_MIN_MEM_MB=0\nRT_MAX_MEM_PSI=100000\n');
  // Stale temp entries: rt-tmpclean would prune them if it ran.
  const stale = join(tmp, 'rt-lock-stale');
  const oldLock = join(statedir, 'locks', 'old');
  mkdirSync(stale);
  mkdirSync(oldLock, { recursive: true });
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  utimesSync(stale, old, old);
  utimesSync(oldLock, old, old);
  const before = snapshot(box);
  const args = [sched, '--once'];
  if (dry) args.push('--dry-run');
  const r = spawnSync('python3', args, {
    env: { ...process.env, RT_HOME: home, RT_GH_REAL: join(fx, 'gh'), FAKE_GH_LOG: join(fx, 'gh.log'), PYTHONDONTWRITEBYTECODE: '1',
      TMPDIR: tmp, RTW_STATE_DIR: statedir, XDG_STATE_HOME: join(box, 'xdg') },
    encoding: 'utf8',
  });
  const lines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);
  return {
    status: r.status, stderr: r.stderr, sched: lines(join(home, 'logs', 'sched.log')), gh: lines(join(fx, 'gh.log')),
    home, spawned: existsSync(join(home, 'SPAWNED')), before, after: snapshot(box), stale, oldLock,
  };
}

test('dry-run spawns no worker and runs no GitHub write verb', (t) => {
  const r = runSched(t, { dry: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.sched.some((l) => l.includes('DRY would claim #7')), r.sched.join('\n'));
  assert.equal(r.spawned, false, 'a worker was spawned');
  for (const c of r.gh) {
    const verb = c.split(' ').slice(0, 2).join(' ');
    assert.ok(READ_VERBS.has(verb), 'non-read gh call in dry-run: ' + c);
  }
});

test('dry-run writes no state files, no heartbeat, and runs no tmp cleanup (logs excepted)', (t) => {
  const r = runSched(t, { dry: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.after, r.before, 'dry-run changed local state');
  assert.ok(existsSync(r.stale), 'rt-tmpclean pruned TMPDIR in dry-run');
  assert.ok(existsSync(r.oldLock), 'rt-tmpclean pruned the state lock dir in dry-run');
});

test('non-dry run still claims and spawns the worker (control)', async (t) => {
  const r = runSched(t, { dry: false });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.sched.some((l) => l.includes('spawned worker #7')), 'worker was not spawned without --dry-run\n' + r.sched.join('\n'));
  // The worker is detached and writes SPAWNED after sched exits; wait (bounded) so cleanup does not race it.
  const marker = join(r.home, 'SPAWNED');
  for (let i = 0; i < 100 && !existsSync(marker); i++) await sleep(100);
  assert.ok(existsSync(marker), 'detached worker never finished');
});
