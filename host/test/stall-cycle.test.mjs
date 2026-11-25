// Stall cycle wiring (#668): each non-dry scheduler cycle hands its snapshot to the stall cycle, which fires each key once.
// Fixtures only: fake gh, isolated RT_HOME, and a canary webhook that must receive nothing (RT_TEST=1 keeps the sink off).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const sched = join(hostDir, 'rt-sched.py');

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
if [ "$1 $2" = "issue comment" ]; then cat >> "$FAKE_GH_LOG.bodies"; fi
case "$1 $2" in
  "issue list") case "$*" in *"--state all"*) echo "$ALL_ISSUES";; *) echo "$OPEN_ISSUES";; esac;;
  "issue view") echo '{"comments":[]}';;
  "pr list"|"run list") echo '[]';;
  *) echo '{}';;
esac
`;

// #5 waits on #6 (rt:hold, so nothing claims it): rt:go backlog that nothing takes => idle-backlog on root #6.
// #9 is rt:blocked since 2020 (status.tsv ts) => stale-wait on #9 from the first cycle.
const OPEN = [
  { number: 5, title: '[T] backlog', body: 'Depends on #6', labels: [{ name: 'rt:go' }], createdAt: '2026-01-01T00:00:00Z' },
  { number: 6, title: '[T] held root', body: '', labels: [{ name: 'rt:hold' }], createdAt: '2026-01-01T00:00:00Z' },
  { number: 9, title: '[T] blocked', body: '', labels: [{ name: 'rt:blocked' }], createdAt: '2026-01-01T00:00:00Z' },
];
const ALL = [5, 6, 9].map((number) => ({ number, state: 'OPEN' }));

// Sandbox: RT_HOME, fake gh, and a canary webhook listener (127.0.0.1 only).
async function sandbox(t) {
  const box = mkdtempSync(join(tmpdir(), 'stall-cycle-'));
  const hook = { url: '', requests: [] };
  const server = createServer((req, res) => { hook.requests.push(req.url); req.resume(); res.writeHead(200); res.end(); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  hook.url = `http://127.0.0.1:${server.address().port}/hook`;
  t.after(() => { rmSync(box, { recursive: true, force: true }); server.close(); });
  const home = join(box, 'rt');
  mkdirSync(home);
  writeFileSync(join(home, 'fakegh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(home, 'config.env'), 'RT_REPO=example/repo\nRT_OWNER=owner\nRT_WORKERS=1\nRT_MAX_LOAD=100000\nRT_MIN_MEM_MB=0\nRT_MAX_MEM_PSI=100000\n');
  writeFileSync(join(home, 'status.tsv'), '9\tstop\t0\t2020-01-01 00:00:00 UTC\tparked\n');
  return { home, hook, env: { ...process.env, RT_HOME: home, RT_GH_REAL: join(home, 'fakegh'), FAKE_GH_LOG: join(home, 'gh.log'),
    OPEN_ISSUES: JSON.stringify(OPEN), ALL_ISSUES: JSON.stringify(ALL), PYTHONDONTWRITEBYTECODE: '1', RT_TEST: '1',
    TMPDIR: box, RTW_STATE_DIR: join(box, 'statedir'), XDG_STATE_HOME: join(box, 'xdg'),
    RT_NOTIFY_WEBHOOK_URL: hook.url, RT_NOTIFY_WEBHOOK_KEY: 'isolation-key' } };
}

// Runs `cycles` scheduler cycles in one python process (same RT_HOME, so loop-stall.json persists across calls).
function runCycles({ env }, cycles, dry) {
  const py = `import importlib.util, sys
spec = importlib.util.spec_from_file_location("rt_sched", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
s = m.Sched(sys.argv[3] == "1", True)
for _ in range(int(sys.argv[2])): s.cycle()
`;
  const r = spawnSync('python3', ['-c', py, sched, String(cycles), dry ? '1' : '0'], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
}

const lines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);
const notices = (home) => lines(join(home, '.roundtable/state/outbox.jsonl'))
  .map((l) => JSON.parse(l)).filter((l) => l.type === 'item' && l.item.kind === 'notification').map((l) => l.item.id);
const comments = (home) => lines(join(home, 'gh.log')).filter((c) => c.startsWith('issue comment'));

test('the stall cycle fires each key once: stale-wait at the first cycle, idle-backlog at the sixth, no repeats', async (t) => {
  const s = await sandbox(t);
  runCycles(s, 5, false);
  assert.deepEqual(notices(s.home).map((id) => id.replace(/:\d{4}-\d{2}-\d{2}$/, '')), ['notice:stall:stale-wait:9']);
  runCycles(s, 1, false);
  assert.deepEqual(notices(s.home).map((id) => id.replace(/:\d{4}-\d{2}-\d{2}$/, '')).sort(),
    ['notice:stall:idle-backlog:6', 'notice:stall:stale-wait:9']);
  runCycles(s, 2, false);
  assert.equal(notices(s.home).length, 2, 'a repeated key fired again');
  assert.equal(comments(s.home).length, 2, 'each alert is delivered once, through the bridge');
  const alerts = lines(join(s.home, 'gh.log.bodies')).filter((b) => b.includes('Stall alert for'));
  assert.equal(alerts.length, 2);
  for (const alert of alerts) {
    assert.match(alert, /Stall alert for \S+/);
    assert.doesNotMatch(alert, /undefined/);
  }
  assert.equal(s.hook.requests.length, 0, 'a test reached the webhook');
});

test('dry-run stays side-effect free: no outbox item, no ledger, no alert, even past the idle threshold', async (t) => {
  const s = await sandbox(t);
  runCycles(s, 8, true);
  assert.equal(existsSync(join(s.home, '.roundtable/state/outbox.jsonl')), false);
  assert.equal(existsSync(join(s.home, '.roundtable/state/loop-stall.json')), false);
  assert.equal(comments(s.home).length, 0);
  assert.equal(s.hook.requests.length, 0);
});
