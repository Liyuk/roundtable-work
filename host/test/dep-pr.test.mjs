// Dependencies on PR numbers (#540): a merged PR is met, an open PR is unmet, an unresolvable number is logged live (once per hour).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sched = join(dirname(fileURLToPath(import.meta.url)), '..', 'rt-sched.py');

const issue = (number, dep) => ({ number, title: `[T] task ${number}`, body: `Depends on #${dep}`, labels: [{ name: 'rt:go' }], createdAt: '2026-01-01T00:00:00Z' });
const ISSUES = [issue(20, 10), issue(21, 11), issue(22, 12)];   // 10 = merged PR, 11 = open PR, 12 = neither

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "issue list") case "$*" in *"--state all"*) echo "$ALL_ISSUES";; *) echo "$OPEN_ISSUES";; esac;;
  "pr list") case "$*" in *"--state merged"*) echo "$MERGED_PRS";; *) echo "$OPEN_PRS";; esac;;
  "run list") echo '[]';;
esac
`;

// Runs one Sched cycle in dry-run or live mode and returns the sched log lines.
function cycle(t, { dry, openPrs, issues }) {
  const home = mkdtempSync(join(tmpdir(), 'rt-deppr-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fakegh = join(home, 'fakegh');
  writeFileSync(fakegh, FAKE_GH, { mode: 0o755 });
  writeFileSync(join(home, 'config.env'), '');
  const gh = join(home, 'gh.log');
  const env = {
    ...process.env,
    RT_HOME: home, RT_GH_REAL: fakegh, FAKE_GH_LOG: gh, PYTHONDONTWRITEBYTECODE: '1',
    ALL_ISSUES: "[]",
    OPEN_ISSUES: JSON.stringify(issues),
    MERGED_PRS: JSON.stringify([{ number: 10 }]),
    OPEN_PRS: JSON.stringify(openPrs),
  };
  const py = `import importlib.util, sys
spec = importlib.util.spec_from_file_location("rt_sched", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
s = m.Sched(sys.argv[2] == "dry", True)
for _ in range(int(sys.argv[3])): s.cycle()
`;
  const r = spawnSync('python3', ['-c', py, sched, dry ? 'dry' : 'live', '2'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const log = join(home, 'logs', 'sched.log');
  return { out: r.stdout, sched: existsSync(log) ? readFileSync(log, 'utf8') : '' };
}

test('an rt:go issue depending on a merged PR is claimable (#540)', (t) => {
  const { out } = cycle(t, { dry: true, openPrs: [], issues: [issue(20, 10)] });
  assert.match(out, /DRY would claim #20 /);
});

test('an rt:go issue depending on an open PR is not claimed (#540)', (t) => {
  const { out } = cycle(t, { dry: true, openPrs: [{ number: 11, headRefName: 'rt/11-x', labels: [], isDraft: false, title: 'x', comments: [] }], issues: [issue(21, 11)] });
  assert.doesNotMatch(out, /DRY would claim #21/);
  assert.match(out, /DRY skip #21: dependency not satisfied: #11 \(open PR\)/);
});

test('an unresolvable dependency logs once per issue per hour in live mode (#540)', (t) => {
  const { sched } = cycle(t, { dry: false, openPrs: [], issues: [issue(22, 12)] });
  const lines = sched.split('\n').filter((l) => l.includes('#22') && l.includes('#12'));
  assert.equal(lines.length, 1, sched);
  assert.match(lines[0], /#22\b.*#12/);
});
