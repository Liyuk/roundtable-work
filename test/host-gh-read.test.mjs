// GitHub read resilience (#652): a failed read is retried once, a failed allst/merged read falls back to the last good
// value for at most 2 cycles, and a failed open-issue or open-PR read skips claims only. Fixtures only: a fake gh in a
// temp host copy; no network, no real GitHub, no real clock (jitter is zeroed, the timeout is injected).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['releases', 'test', 'deploy', 'config.env', 'state', 'logs', 'locks', 'status.tsv']);
const DEP = { number: 10, title: 'Dependent', body: 'Depends on #9', labels: [], createdAt: '2020-01-01T00:00:00Z' };

// Driver: one Sched, `steps` cycles in one process (the cache lives in memory). Each step writes the fail pattern that the
// fake gh uses to fail matching calls. timeoutFirst makes the first gh call raise TimeoutExpired (no real wait).
const DRIVER = `
import importlib.util, json, os, subprocess, sys
spec = importlib.util.spec_from_file_location("rt_sched", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
cfg = json.loads(sys.argv[2])
base = cfg["base"]
mod.GH_JITTER = 0
timeouts, calls = [], []
real_run = subprocess.run
def run(cmd, **kw):
    if cmd and cmd[0] == mod.GH:
        timeouts.append(kw.get("timeout"))
        calls.append(cmd[1:])
        if cfg["timeoutFirst"] and len(timeouts) == 1:
            raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
    return real_run(cmd, **kw)
subprocess.run = run
s = mod.Sched(cfg["dry"], True)
for fail in cfg["steps"]:
    open(os.path.join(base, "fail"), "w").write(fail)
    s.cycle()
print(json.dumps({"timeouts": timeouts, "calls": calls}))
`;

function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'rt-gh-read-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'rt-home');
  mkdirSync(home);
  for (const name of readdirSync(join(repo, 'host'))) {
    if (!SKIP.has(name)) cpSync(join(repo, 'host', name), join(home, name), { recursive: true });
  }
  cpSync(join(repo, 'host', 'config.env.example'), join(home, 'config.env'));
  // Permissive resource hold: live load/memory/PSI must not throttle the cycle.
  appendFileSync(join(home, 'config.env'), 'RT_MAX_LOAD=1e9\nRT_MIN_MEM_MB=0\nRT_MAX_MEM_PSI=1e9\n');
  cpSync(join(repo, 'runtime'), join(base, 'runtime'), { recursive: true });
  writeFileSync(join(base, 'issues.json'), JSON.stringify([]));
  writeFileSync(join(base, 'allst.json'), JSON.stringify([{ number: 9, state: 'OPEN' }]));
  writeFileSync(join(base, 'merged.json'), JSON.stringify([{ number: 9 }]));
  writeFileSync(join(base, 'fail'), '');
  // Fake gh: answers from fixtures; a call containing the `fail` pattern exits 1 (a failed read).
  writeFileSync(join(base, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${base}/gh.log"
if [ -s "${base}/fail" ] && grep -qF -- "$(cat "${base}/fail")" <<< "$*"; then echo boom >&2; exit 1; fi
case "$*" in
  *"--state all"*) cat "${base}/allst.json";;
  *"issue list"*) cat "${base}/issues.json";;
  *"--state merged"*) cat "${base}/merged.json";;
  *"issue view"*) echo '{"comments":[]}';;
  *) echo '[]';;
esac
`);
  chmodSync(join(base, 'gh'), 0o755);
  // Drop inherited RT_*/GH_* (live config and tokens) so only the sandbox applies.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RT_|GH_|GITHUB_)/.test(k)));
  return { base, home, env: { ...inherited, RT_HOME: home, RT_GH_REAL: join(base, 'gh'), PYTHONDONTWRITEBYTECODE: '1' } };
}

function cycles(t, { dry, steps, timeoutFirst = false, issues }) {
  const sb = sandbox(t);
  if (issues) writeFileSync(join(sb.base, 'issues.json'), JSON.stringify(issues));
  const cfg = JSON.stringify({ base: sb.base, dry, steps, timeoutFirst });
  const r = spawnSync('python3', ['-c', DRIVER, join(sb.home, 'rt-sched.py'), cfg], { env: sb.env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const logP = join(sb.home, 'logs', 'sched.log');
  const log = existsSync(logP) ? readFileSync(logP, 'utf8').split('\n') : [];
  const ghLog = existsSync(join(sb.base, 'gh.log')) ? readFileSync(join(sb.base, 'gh.log'), 'utf8').split('\n').filter(Boolean) : [];
  return { ...JSON.parse(r.stdout.trim().split('\n').pop()), log, ghLog, home: sb.home, count: (re) => log.filter((l) => re.test(l)).length };
}

test('a timed-out read is retried once with the 60 s timeout and the cycle completes', (t) => {
  const r = cycles(t, { dry: false, steps: [''], timeoutFirst: true });
  assert.deepEqual(r.timeouts.slice(0, 2), [60, 60], 'first attempt and its retry both use the 60 s timeout');
  assert.deepEqual(r.calls[0], r.calls[1], 'the retry repeats the same read');
  assert.equal(r.count(/gh_read_fail|ERROR/), 0);
  assert.equal(existsSync(join(r.home, 'state', 'heartbeat')), true);
});

test('a failed merged-PR read uses the cached set for at most 2 cycles, and the dependency stays met', (t) => {
  const r = cycles(t, { dry: true, steps: ['', '--state merged', '--state merged', '--state merged'], issues: [DEP] });
  assert.equal(r.count(/DRY would claim #10 /), 3, 'cycles 1-3 claim #10: #9 is met by the cached merged set');
  assert.equal(r.count(/DRY skip #10: dependency not satisfied: #9 \(open, no PR\)/), 1, 'cycle 4: the cache is 3 cycles old and is dropped');
  assert.equal(r.count(/gh_read_fail/), 3);
});

test('a failed open-issue read (both attempts) makes no claim, still writes the heartbeat, and is counted', (t) => {
  const r = cycles(t, { dry: false, steps: ['--state open --author', '--state open --author'], issues: [DEP] });
  assert.equal(r.ghLog.filter((l) => l.includes('--state open --author')).length, 4, 'each failed read is retried once');
  assert.equal(r.count(/spawned|gh_read_fail/), 2, 'no worker spawn; one counted failure per cycle');
  assert.equal(r.ghLog.some((l) => l.startsWith('label') || l.includes('issue edit')), false, 'no label write (no claim)');
  assert.equal(existsSync(join(r.home, 'state', 'heartbeat')), true);
});

test('a failed open-PR read makes no claim, but the cycle still reaches main health and writes the heartbeat', (t) => {
  const r = cycles(t, { dry: false, steps: ['--state open -L 200 --json number,headRefName'], issues: [DEP] });
  assert.equal(r.count(/spawned|gh_read_fail gh pr list/), 1, 'no worker spawn; the failed PR read is counted');
  assert.equal(r.ghLog.some((l) => l.startsWith('run list')), true, 'check_main still runs');
  assert.equal(existsSync(join(r.home, 'state', 'heartbeat')), true);
});

test('a failed open-issue read still respawns an orphan from the last good list (cache at most 2 cycles), and with no cache nothing respawns', (t) => {
  const ORPHAN = { number: 11, title: 'Orphan', body: '', labels: [{ name: 'rt:running' }], createdAt: '2020-01-01T00:00:00Z' };
  const fail = '--state open --author';
  const ok = cycles(t, { dry: true, steps: ['', fail, fail, fail, fail], issues: [ORPHAN] });
  assert.equal(ok.count(/DRY would resume orphan #11/), 3, 'cycles 1-3 respawn; cycle 4 the cache is 3 cycles old and is dropped');
  assert.equal(ok.count(/DRY would claim/), 0, 'no claim while the open-issue read fails');
  const never = cycles(t, { dry: true, steps: [fail, fail], issues: [ORPHAN] });
  assert.equal(never.count(/resume orphan/), 0, 'no cached list: nothing respawns');
});
