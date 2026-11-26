// Host script drift (#653): deployed rt-sched.py, rt-work.sh and bin/* vs host/ at origin/main. Local fixtures only:
// the reference is a temp git repo with a refs/remotes/origin/main ref and no remote; the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3600;
const T0 = 1_800_000_000;
const FILES = { 'host/rt-sched.py': 'print(1)\n', 'host/rt-work.sh': 'echo work\n', 'host/bin/rt-x': 'echo x\n' };
const DEPLOYED = { 'rt-sched.py': FILES['host/rt-sched.py'], 'rt-work.sh': FILES['host/rt-work.sh'], 'bin/rt-x': FILES['host/bin/rt-x'] };

const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
const DRIVER = `import sys, json
sys.path.insert(0, sys.argv[1])
import drift
a = json.loads(sys.argv[2])
print(json.dumps(drift.check(a["home"], a["repo"], a["state"], a["logs"], a["now"], a.get("alert"))))`;

function put(base, rel, content) {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

// repo: a temp git repo whose origin/main is the reference; home: the deployed copy (identical until a test edits it).
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rt-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), home = join(root, 'rt'), state = join(root, 'rt', 'state'), logs = join(root, 'rt', 'logs');
  mkdirSync(repo); mkdirSync(state, { recursive: true }); mkdirSync(logs);
  for (const [rel, c] of Object.entries(FILES)) put(repo, rel, c);
  for (const [rel, c] of Object.entries(DEPLOYED)) put(home, rel, c);
  spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { check: true });
  spawnSync('git', ['-C', repo, ...GIT, 'add', '-A']);
  spawnSync('git', ['-C', repo, ...GIT, 'commit', '-q', '-m', 'host']);
  spawnSync('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return { root, repo, home, state, logs };
}

// Runs drift.check in Python with the given clock and returns the drifted file list.
function check(f, now, alert) {
  const args = JSON.stringify({ home: f.home, repo: f.repo, state: f.state, logs: f.logs, now, alert });
  const r = spawnSync('python3', ['-c', DRIVER, host, args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function ledger(f) {
  const p = join(f.logs, 'drift-ledger.jsonl');
  return existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// Runs one non-dry scheduler cycle against the fixture home (fake gh: no network) and returns the heartbeat text.
function heartbeat(f) {
  const fx = join(f.root, 'fx');
  mkdirSync(fx);
  writeFileSync(join(fx, 'gh'), '#!/usr/bin/env bash\necho "[]"\n', { mode: 0o755 });
  put(f.home, 'config.env', 'RT_REPO=example/repo\nRT_OWNER=owner\nRT_WORKERS=1\nRT_MAX_LOAD=100000\nRT_MIN_MEM_MB=0\nRT_MAX_MEM_PSI=100000\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RT_')));
  const r = spawnSync('python3', [join(host, 'rt-sched.py'), '--once'], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...env, RT_HOME: f.home, RT_REPO_DIR: f.repo, RT_GH_REAL: join(fx, 'gh') },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return readFileSync(join(f.home, 'state', 'heartbeat'), 'utf8');
}

test('one modified deployed file is the only file reported in drift', (t) => {
  const f = fixture(t);
  put(f.home, 'bin/rt-x', 'echo changed on the host\n');
  assert.deepEqual(check(f, T0), ['bin/rt-x']);
});

test('identical trees report no drift', (t) => {
  const f = fixture(t);
  assert.deepEqual(check(f, T0), []);
});

test('heartbeat carries drift=<files> for the modified file', (t) => {
  const f = fixture(t);
  put(f.home, 'rt-work.sh', 'echo hotfix\n');
  assert.match(heartbeat(f), /^drift=rt-work\.sh$/m);
});

test('heartbeat carries an empty drift= when the trees are identical', (t) => {
  const f = fixture(t);
  assert.match(heartbeat(f), /^drift=$/m);
});

test('24 effective hours of continuous drift append exactly one ledger line', (t) => {
  const f = fixture(t);
  put(f.home, 'bin/rt-x', 'hotfix\n');
  check(f, T0);
  check(f, T0 + 24 * HOUR - 1);
  assert.equal(ledger(f).length, 0);
  check(f, T0 + 24 * HOUR);
  check(f, T0 + 25 * HOUR);
  const lines = ledger(f);
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].files, ['bin/rt-x']);
  assert.equal(lines[0].since, T0);
});

test('a clean check resets the drift clock', (t) => {
  const f = fixture(t);
  put(f.home, 'bin/rt-x', 'hotfix\n');
  check(f, T0);
  put(f.home, 'bin/rt-x', FILES['host/bin/rt-x']);
  check(f, T0 + 12 * HOUR);
  put(f.home, 'bin/rt-x', 'hotfix again\n');
  check(f, T0 + 13 * HOUR);
  check(f, T0 + 36 * HOUR);
  assert.equal(ledger(f).length, 0);
  check(f, T0 + 37 * HOUR);
  assert.equal(ledger(f).length, 1);
  assert.equal(ledger(f)[0].since, T0 + 13 * HOUR);
});

test('RT_DRIFT_ALERT_CMD runs once with the drifted files when the ledger line is written', (t) => {
  const f = fixture(t);
  const alerts = join(f.root, 'alerts.txt');
  put(f.home, 'bin/rt-x', 'hotfix\n');
  const alert = `printf '%s\\n' "$RT_DRIFT_FILES" >> ${alerts}`;
  check(f, T0, alert);
  check(f, T0 + 24 * HOUR, alert);
  check(f, T0 + 25 * HOUR, alert);
  assert.equal(readFileSync(alerts, 'utf8'), 'bin/rt-x\n');
});
