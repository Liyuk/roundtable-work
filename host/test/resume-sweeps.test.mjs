// Resume and terminal-state sweeps (#650): an owner comment re-opens a terminal issue, a failed issue is requeued once or parked,
// and ready-to-merge issues whose PR is gone are closed (merged without Closes) or requeued (closed unmerged).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sched = join(dirname(fileURLToPath(import.meta.url)), '..', 'rt-sched.py');

const issue = (number, labels = []) => ({ number, title: `[T] task ${number}`, body: 'body', labels: labels.map((name) => ({ name })), createdAt: '2026-01-01T00:00:00Z' });
const OWNER_COMMENT = { author: { login: 'test-owner' }, createdAt: '2026-06-01T00:00:00Z', body: 'please resume' };

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "issue list") case "$*" in *"--state all"*) echo "$ALL_ISSUES";; *) echo "$OPEN_ISSUES";; esac;;
  "issue view") echo "$COMMENTS";;
  "issue comment") cat >> "$FAKE_GH_LOG";;
  "pr list") case "$*" in *"--state merged"*) echo "$MERGED_PRS";; *"--state closed"*) echo "$CLOSED_PRS";; *) echo "$OPEN_PRS";; esac;;
  "run list") echo '[]';;
esac
`;

// Writes the status rows and per-issue state, then runs one live Sched cycle (RT_WORKERS=0: nothing is claimed).
function cycle(t, home, { status = {}, state = {}, issues = [], comments = [], openPrs = [], mergedPrs = [], closedPrs = [] }) {
  if (!home) {
    home = mkdtempSync(join(tmpdir(), 'rt-sweeps-'));
    t.after(() => rmSync(home, { recursive: true, force: true }));
  }
  const fakegh = join(home, 'fakegh');
  writeFileSync(fakegh, FAKE_GH, { mode: 0o755 });
  writeFileSync(join(home, 'config.env'), 'RT_WORKERS=0\nRT_OWNER=test-owner\nRT_REPO=test/repo\n');
  writeFileSync(join(home, 'status.tsv'), Object.entries(status).map(([n, [st, detail]]) => `${n}\t${st}\t0\t2026-01-01 00:00:00 UTC\t${detail}\n`).join(''));
  mkdirSync(join(home, 'state', 'issues'), { recursive: true });
  for (const [n, d] of Object.entries(state)) writeFileSync(join(home, 'state', 'issues', `${n}.json`), JSON.stringify(d));
  const gh = join(home, 'gh.log');
  rmSync(gh, { force: true });
  const env = {
    ...process.env,
    RT_HOME: home, RT_GH_REAL: fakegh, FAKE_GH_LOG: gh, PYTHONDONTWRITEBYTECODE: '1',
    ALL_ISSUES: '[]', OPEN_ISSUES: JSON.stringify(issues), COMMENTS: JSON.stringify({ comments }),
    MERGED_PRS: JSON.stringify(mergedPrs), CLOSED_PRS: JSON.stringify(closedPrs), OPEN_PRS: JSON.stringify(openPrs),
  };
  const py = `import importlib.util, sys
spec = importlib.util.spec_from_file_location("rt_sched", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
m.Sched(False, True).cycle()
`;
  const r = spawnSync('python3', ['-c', py, sched], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const st = {};
  for (const line of readFileSync(join(home, 'status.tsv'), 'utf8').split('\n').filter(Boolean)) {
    const [n, state_, , , detail] = line.split('\t');
    st[n] = { state: state_, detail };
  }
  return { home, status: st, gh: readFileSync(gh, 'utf8') };
}

test('an owner comment on a done ready-to-merge issue re-opens it (#650 case 1)', (t) => {
  const { status, gh } = cycle(t, null, {
    issues: [issue(1, ['rt:ready-to-merge'])],
    status: { 1: ['done', 'no PR needed'] },
    comments: [OWNER_COMMENT],
  });
  assert.equal(status[1].state, 'queued');
  assert.match(gh, /issue edit 1 .*--remove-label rt:ready-to-merge/);
});

test('an error with an internal cause is requeued once, then parked with rt:blocked (#650 case 2)', (t) => {
  const first = cycle(t, null, { issues: [issue(2)], status: { 2: ['error', 'worker exited rc=-15 without a final state'] } });
  assert.equal(first.status[2].state, 'queued');
  assert.match(first.status[2].detail, /requeued by the sweep/);
  assert.doesNotMatch(first.gh, /rt:blocked/);

  const second = cycle(t, first.home, { issues: [issue(2)], status: { 2: ['error', 'worker exited rc=-15 without a final state'] } });
  assert.equal(second.status[2].state, 'error');
  assert.match(second.gh, /issue edit 2 .*--add-label rt:blocked/);
  assert.match(second.gh, /<!-- rt:blocked -->/);
});

test('a ready-to-merge issue whose PR merged without Closes is closed by the sweep (#650 case 3)', (t) => {
  const { status, gh } = cycle(t, null, {
    issues: [issue(3, ['rt:ready-to-merge'])],
    mergedPrs: [{ number: 30, headRefName: 'rt/3-pi', body: 'no closing keyword' }],
  });
  assert.match(gh, /issue close 3 /);
  assert.equal(status[3].state, 'done');
  assert.equal(status[3].detail, 'merged without Closes; closed by sweep');
});

test('a ready-to-merge issue whose PR was closed unmerged is requeued (#650 case 4)', (t) => {
  const { status, gh } = cycle(t, null, {
    issues: [issue(4, ['rt:ready-to-merge'])],
    closedPrs: [{ number: 40, headRefName: 'rt/4-pi', body: '' }],
  });
  assert.equal(status[4].state, 'queued');
  assert.match(gh, /issue edit 4 .*--remove-label rt:ready-to-merge/);
  assert.doesNotMatch(gh, /issue close 4 /);
});
