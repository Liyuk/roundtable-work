// Verified-complete leaves and parents (#646): the scheduler closes them once children are closed and the newest main Check run is green;
// intake sees the closed dependency in the same cycle; rt-work's handle_done waits for a pending main Check run instead of asking the owner.
// Fixtures only: fake gh, dry-run scheduler, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const sched = join(hostDir, 'rt-sched.py');
const RUN = (status, conclusion = '') => ({ status, conclusion, headSha: 'abcdef1234567890', databaseId: 1 });

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "issue list") case "$*" in *"--state all"*) echo "$ALL_ISSUES";; *) echo "$OPEN_ISSUES";; esac;;
  "pr list") echo '[]';;
  "run list") cat "$FAKE_RUNS";;
  "issue view") echo '{"comments":[]}';;
esac
`;

// One scheduler process, one dry-run cycle per entry of `runsPerCycle` (the main Check runs that gh reports in that cycle).
function cycles(t, { issues, closed, status, children, runsPerCycle }) {
  const home = mkdtempSync(join(tmpdir(), 'rt-verified-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'fakegh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(home, 'config.env'), 'RT_REPO=example/repo\nRT_OWNER=owner\nRT_WORKERS=3\nRT_MAX_LOAD=100000\nRT_MIN_MEM_MB=0\nRT_MAX_MEM_PSI=100000\n');
  mkdirSync(join(home, 'state', 'children'), { recursive: true });
  for (const [n, kids] of Object.entries(children)) writeFileSync(join(home, 'state', 'children', n), kids);
  writeFileSync(join(home, 'status.tsv'), status.map(([n, state, detail]) => `${n}\t${state}\t0\t2026-01-01 00:00:00 UTC\t${detail}`).join('\n') + '\n');
  const env = {
    ...process.env,
    RT_HOME: home, RT_GH_REAL: join(home, 'fakegh'), FAKE_GH_LOG: join(home, 'gh.log'), FAKE_RUNS: join(home, 'runs.json'),
    PYTHONDONTWRITEBYTECODE: '1',
    OPEN_ISSUES: JSON.stringify(issues),
    ALL_ISSUES: JSON.stringify([...issues.map((i) => ({ number: i.number, state: 'OPEN' })), ...closed.map((n) => ({ number: n, state: 'CLOSED' }))]),
  };
  const py = `import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("rt_sched", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
s = m.Sched(True, True)
for runs in json.loads(sys.argv[2]):
    open(os.environ["FAKE_RUNS"], "w").write(json.dumps(runs))
    s.cycle()
    print("--CYCLE--")
`;
  const r = spawnSync('python3', ['-c', py, sched, JSON.stringify(runsPerCycle)], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('--CYCLE--\n').slice(0, -1);
}

const issue = (number, { body = '', labels = ['rt:go'] } = {}) => ({
  number, title: `[T] task ${number}`, body, labels: labels.map((name) => ({ name })), createdAt: '2026-01-01T00:00:00Z',
});
const VERIFIED = [['100', 'done', 'no PR needed (verified complete)']];
const leaf = issue(100, { labels: ['rt:ready-to-merge'] });

test('a verified-complete leaf with all children closed and main green is closed as done (#646)', (t) => {
  const [out] = cycles(t, {
    issues: [leaf], closed: [101], status: VERIFIED, children: { 100: '101\n' }, runsPerCycle: [[RUN('completed', 'success')]],
  });
  assert.match(out, /DRY would close #100$/m);
  assert.match(out, /DRY would set status #100 done \(no PR needed \(verified complete, closed by sweep\)\)/);
});

test('a childless verified-complete leaf (no children file) with main green is closed as done (#646)', (t) => {
  const [out] = cycles(t, {
    issues: [issue(100, { labels: ['rt:ready-to-merge'] })], closed: [], status: [['100', 'ready', 'verified complete']], children: {},
    runsPerCycle: [[RUN('completed', 'success')]],
  });
  assert.match(out, /DRY would close #100$/m);
  assert.match(out, /DRY would set status #100 done \(no PR needed \(verified complete, closed by sweep\)\)/);
});

test('the same leaf is not closed while main is pending or red, and is closed on the first cycle main is green (#646)', (t) => {
  const [red, pending, green] = cycles(t, {
    issues: [leaf], closed: [101], status: VERIFIED, children: { 100: '101\n' },
    runsPerCycle: [[RUN('completed', 'failure')], [RUN('in_progress'), RUN('completed', 'success')], [RUN('completed', 'success')]],
  });
  assert.doesNotMatch(red, /DRY would close #100/);
  assert.doesNotMatch(pending, /DRY would close #100/);
  assert.match(green, /DRY would close #100$/m);
});

test('a parent with an open child is untouched even when main is green (#646)', (t) => {
  const [out] = cycles(t, {
    issues: [leaf], closed: [], status: VERIFIED, children: { 100: '101\n' }, runsPerCycle: [[RUN('completed', 'success')]],
  });
  assert.doesNotMatch(out, /DRY would close #100/);
});

test('after #562 closes in a cycle, its dependent #565 is claimed in that same cycle (#646)', (t) => {
  const [out] = cycles(t, {
    issues: [issue(562, { labels: ['rt:ready-to-merge'] }), issue(565, { body: 'Depends on #562' })],
    closed: [563], status: [['562', 'done', 'no PR needed (verified complete)']], children: { 562: '563\n' },
    runsPerCycle: [[RUN('completed', 'success')]],
  });
  const closeAt = out.indexOf('DRY would close #562');
  const claimAt = out.indexOf('DRY would claim #565');
  assert.ok(closeAt >= 0, out);
  assert.ok(claimAt > closeAt, out);
});

// rt-work.sh is not sourceable, so the real handle_done text is extracted and run with stubbed side effects.
const HANDLE_DONE_HARNESS = `set -uo pipefail
n=646; wake=1; WAIT_SLEEP=300; RT_REPO=example/repo; RT_HOME="$H"; GH="$H/fakegh"; STATE="$H/state"; SD="$H/sd"
mkdir -p "$STATE" "$SD" "$H/logs"
printf '%s\\n' 'DECISION' 'no-pr' 'verified against main' >"$SD/DECISION"
log(){ :; }; label(){ :; }; release(){ :; }; gate_pipeline(){ :; }
say(){ echo "say $1 $2 $3 $4" >>"$H/out"; }
setstatus(){ echo "status $*" >>"$H/out"; }
eval "$(sed -n '/^handle_done(){/,/^}/p' "$RT_WORK")"
handle_done
echo "rc=$?" >>"$H/out"
`;

test('handle_done with an in-progress main Check run posts no owner ask and leaves a waiting retry marker (#646)', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'rt-handle-done-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'fakegh'), '#!/usr/bin/env bash\necho "$*" >> "$H/gh.log"\ncase "$1 $2" in\n  "run list") echo \'[{"status":"in_progress","conclusion":""},{"status":"completed","conclusion":"success"}]\';;\n  "issue view") echo OPEN;;\nesac\n', { mode: 0o755 });
  mkdirSync(join(home, 'bin'));
  writeFileSync(join(home, 'bin', 'rt-timers.mjs'), "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.H + '/timer.log', process.argv.slice(2).join(' ') + '\\n');\n");
  const r = spawnSync('bash', [], {
    input: HANDLE_DONE_HARNESS,
    env: { ...process.env, H: home, RT_WORK: join(hostDir, 'rt-work.sh') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const out = readFileSync(join(home, 'out'), 'utf8');
  assert.doesNotMatch(out, /Please review and close/);
  assert.match(out, /^status 646 waiting 1 main Check run pending/m);
  assert.match(out, /rc=1$/m);
  assert.match(readFileSync(join(home, 'timer.log'), 'utf8'), /^wait \S+ 646 /m);
});
