// Wait release (#577): a worker `wait` writes a due timer and exits (slot and lock freed); the issue resumes when the
// timer fires or the awaited event arrives, and a replayed firing is dropped. Fixtures only: no network, no real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACKED_PATH, INBOX_PATH, matchEvents, openInbox } from '../runtime/lib/event-inbox.mjs';
import { openTimers, waitRelease } from '../runtime/lib/event-timers.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const UNBLOCK = '2020-01-01T00:05:00Z';
const AT = Date.parse(UNBLOCK);
const WAIT = { decision: 'wait', event: 'resume', unblockAt: UNBLOCK };
const NO_FLOCK = spawnSync('sh', ['-c', 'command -v flock']).status !== 0;
const SKIP = new Set(['releases', 'test', 'deploy', 'config.env', 'state', 'logs', 'locks', 'status.tsv']);

const withRoot = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'rt-wait-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const readLines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);
const inboxEvents = (root) => readLines(join(root, INBOX_PATH)).map((l) => JSON.parse(l)).filter((r) => r.type === undefined);

test('a wait decision writes one due timer for the issue', () => withRoot((root) => {
  assert.deepEqual(waitRelease(root, { issue: 7, input: WAIT }), { timerId: 'wait:7:resume' });
  assert.deepEqual(openTimers(root).list(), [{
    id: 'wait:7:resume', kind: 'once', at: AT, event: { kind: 'heartbeat', issue: 7, payload: { wait: 'resume' } },
  }]);
}));

test('the due timer fires into the inbox and routes to the waiting issue', () => withRoot((root) => {
  waitRelease(root, { issue: 7, input: WAIT });
  assert.equal(openTimers(root).fire(AT - 1), 0, 'not due before unblockAt');
  assert.equal(openTimers(root).fire(AT), 1);
  assert.deepEqual(inboxEvents(root).map((e) => e.source_event_id), [`timer:wait:7:resume:${AT}`]);
  const { routed } = matchEvents(openInbox(root).events(), new Map([[7, 'line-7']]));
  assert.deepEqual(routed, [{ source_event_id: `timer:wait:7:resume:${AT}`, line: 'line-7' }]);
}));

test('a replayed firing of the same wait timer is dropped by source_event_id', () => withRoot((root) => {
  waitRelease(root, { issue: 7, input: WAIT });
  assert.equal(openTimers(root).fire(AT), 1);
  waitRelease(root, { issue: 7, input: WAIT }); // the same timer written again, as a replay would
  assert.equal(openTimers(root).fire(AT), 0);
  assert.equal(inboxEvents(root).length, 1);
}));

test('rt-timers.mjs wait writes the timer, and rejects an unblock time that does not parse', () => withRoot((root) => {
  const cli = join(repo, 'host', 'bin', 'rt-timers.mjs');
  const ok = spawnSync(process.execPath, [cli, 'wait', root, '7', UNBLOCK], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(openTimers(root).list().map((t) => t.id), ['wait:7:resume']);
  const bad = spawnSync(process.execPath, [cli, 'wait', root, '7', 'soon'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
}));

// ---- host sandbox: a copy of host/ with fake gh, fake chief stage and no real GitHub or model -----------------
function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'rt-wait-host-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'rt-home');
  mkdirSync(home);
  for (const name of readdirSync(join(repo, 'host'))) {
    if (!SKIP.has(name)) cpSync(join(repo, 'host', name), join(home, name), { recursive: true });
  }
  cpSync(join(repo, 'host', 'config.env.example'), join(home, 'config.env'));
  // Permissive resource hold: live load/memory/PSI must not throttle the dry-run cycle (rt-sched reads these keys).
  appendFileSync(join(home, 'config.env'), 'RT_MAX_LOAD=1e9\nRT_MIN_MEM_MB=0\nRT_MAX_MEM_PSI=1e9\n');
  cpSync(join(repo, 'runtime'), join(base, 'runtime'), { recursive: true }); // host/bin/rt-timers.mjs imports ../../runtime
  const fake = (name, body) => { writeFileSync(join(home, 'bin', name), body); chmodSync(join(home, 'bin', name), 0o755); };
  const ghLog = join(base, 'gh.log');
  writeFileSync(join(base, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${ghLog}"
case "$*" in
  *"issue list"*"number,state"*) echo '[{"number":5,"state":"OPEN"}]';;
  *"issue list"*) echo '[{"number":5,"title":"Waiting issue","body":"","labels":[],"createdAt":"2020-01-01T00:00:00Z","state":"OPEN"}]';;
  *) echo '[]';;
esac
`);
  chmodSync(join(base, 'gh'), 0o755);
  // rt-wt: no real worktree; the stage runner: the Chief's DECISION is `wait` with unblock_at from the env.
  fake('rt-wt', `#!/usr/bin/env bash\nmkdir -p "$RT_HOME/wt/$1/.roundtable/state"\n`);
  fake('rt-stage-run', `#!/usr/bin/env bash
cat >/dev/null
echo chief >> "$RT_HOME/chief-calls.log"
printf 'wait\\nawaiting CI\\nunblock_at %s\\n' "$UNBLOCK" > "$RT_HOME/wt/5/.roundtable/state/DECISION"
`);
  // Drop inherited RT_*/GH_* (live config and tokens) so only the sandbox applies.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RT_|GH_|GITHUB_)/.test(k)));
  const env = { ...inherited, RT_HOME: home, RT_GH_REAL: join(base, 'gh'), RT_REPO_DIR: base, UNBLOCK, PYTHONDONTWRITEBYTECODE: '1' };
  return { home, base, env, ghLog };
}

test('a worker wait writes a due timer, exits without a second wake, and frees its slot and lock', { skip: NO_FLOCK ? 'flock(1) is not installed on this platform (e.g. macOS)' : false }, (t) => {
  const { home, env } = sandbox(t);
  const r = spawnSync('bash', [join(home, 'rt-work.sh'), '5'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(readLines(join(home, 'chief-calls.log')), ['chief'], 'the worker must not sleep and wake again');
  const timers = JSON.parse(readFileSync(join(home, '.roundtable', 'state', 'timers.json'), 'utf8'));
  assert.deepEqual(timers.map((x) => [x.id, x.at, x.event.issue]), [['wait:5:resume', AT, 5]]);
  assert.match(readFileSync(join(home, 'status.tsv'), 'utf8'), /^5\twaiting\t1\t/m);
  assert.equal(existsSync(join(home, 'locks', '5.info')), false, 'the slot record is removed on exit');
  assert.equal(spawnSync('flock', ['-n', join(home, 'locks', '5.lock'), '-c', 'true']).status, 0, 'the issue lock is free');
});

// Scheduler (python): the resume decision reads the inbox; a routed unacked event wakes a waiting issue once.
const SCHED_SNIPPET = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("rt_sched", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
s = mod.Sched(False, True)
status = s.read_status()
s.resume_waits(status)
first = status[5]["state"]
s.set_status(5, "waiting", 1, "waiting again")
s.resume_waits(s.read_status())
print(json.dumps({"first": first, "second": s.read_status()[5]["state"]}))
`;
function resumeOf(t, event) {
  const { home, env } = sandbox(t);
  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'status.tsv'), `5\twaiting\t1\t2020-01-01 00:00:00 UTC\twait until ${UNBLOCK}: awaiting CI\n`);
  openInbox(home).accept({ ...event, receivedAt: AT });
  const r = spawnSync('python3', ['-c', SCHED_SNIPPET, join(home, 'rt-sched.py')], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()); // the scheduler logs to stdout before the result line
  return { ...out, acked: readLines(join(home, ACKED_PATH)) };
}

test('the due timer event resumes a waiting issue once (queued, then acked)', (t) => {
  const id = `timer:wait:5:resume:${AT}`;
  const r = resumeOf(t, { source_event_id: id, kind: 'heartbeat', issue: 5, payload: { wait: 'resume' } });
  assert.deepEqual(r, { first: 'queued', second: 'waiting', acked: [id] });
});

test('an awaited event (CI) routed to a waiting issue resumes it', (t) => {
  const r = resumeOf(t, { source_event_id: 'gh-check:unit:success', kind: 'ci', issue: 5, payload: {} });
  assert.deepEqual([r.first, r.acked], ['queued', ['gh-check:unit:success']]);
});

test('a waiting issue with no routed event is not claimed (dry-run cycle)', (t) => {
  const { home, env } = sandbox(t);
  writeFileSync(join(home, 'status.tsv'), `5\twaiting\t1\t2020-01-01 00:00:00 UTC\twait\n`);
  const r = spawnSync('python3', [join(home, 'rt-sched.py'), '--dry-run', '--once'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY skip #5: waiting for its timer or awaited event/);
  assert.doesNotMatch(r.stdout, /DRY would claim #5/);
});

test('a waiting issue with a routed event is claimed again as a resume (dry-run cycle)', (t) => {
  const { home, env } = sandbox(t);
  writeFileSync(join(home, 'status.tsv'), `5\twaiting\t1\t2020-01-01 00:00:00 UTC\twait\n`);
  openInbox(home).accept({ source_event_id: `timer:wait:5:resume:${AT}`, kind: 'heartbeat', issue: 5, payload: {}, receivedAt: AT });
  const r = spawnSync('python3', [join(home, 'rt-sched.py'), '--dry-run', '--once'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY would claim #5 .*\(resume\)/);
  assert.equal(readLines(join(home, ACKED_PATH)).length, 0, 'a dry run acks nothing');
  assert.equal(inboxEvents(home).length, 1);
});
