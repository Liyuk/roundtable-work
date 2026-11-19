// RT_AUTHOR_ALLOWLIST decides which issue authors the scheduler claims (dry-run: logs only, no GitHub write).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sched = join(dirname(fileURLToPath(import.meta.url)), '..', 'rt-sched.py');
const issue = (number, login) => ({ number, state: 'OPEN', title: `[RT-${number}] probe`, body: '', createdAt: '2026-01-01T00:00:00Z',
  labels: [{ name: 'type:bug' }], author: { login } });
const ISSUES = [issue(7, 'guest'), issue(8, 'stranger'), issue(9, 'owner')];

// Fake gh: "issue list --author X" returns only X's issues from $FAKE_ISSUES; without --author, all issues.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "issue list") python3 -c '
import json, os, sys
a = sys.argv[1:]
who = a[a.index("--author") + 1] if "--author" in a else None
print(json.dumps([i for i in json.load(open(os.environ["FAKE_ISSUES"])) if who is None or i["author"]["login"] == who]))' "$@";;
  "pr list"|"run list"|"label list") echo '[]';;
  *) echo '{}';;
esac
`;

function runSched(t, { allowlist }) {
  const box = mkdtempSync(join(tmpdir(), 'rt-allowlist-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const home = join(box, 'rt'), fx = join(box, 'fx');
  for (const d of [home, fx]) mkdirSync(d);
  writeFileSync(join(fx, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(fx, 'issues.json'), JSON.stringify(ISSUES));
  writeFileSync(join(home, 'rt-work.sh'), '#!/usr/bin/env bash\n', { mode: 0o755 });
  writeFileSync(join(home, 'config.env'), 'RT_REPO=example/repo\nRT_OWNER=owner\nRT_WORKERS=3\n' +
    'RT_MAX_LOAD=100000\nRT_MIN_MEM_MB=0\nRT_MAX_MEM_PSI=100000\n' + (allowlist === undefined ? '' : `RT_AUTHOR_ALLOWLIST=${allowlist}\n`));
  const r = spawnSync('python3', [sched, '--once', '--dry-run'], {
    env: { ...process.env, RT_HOME: home, RT_GH_REAL: join(fx, 'gh'), FAKE_GH_LOG: join(fx, 'gh.log'), FAKE_ISSUES: join(fx, 'issues.json'),
      PYTHONDONTWRITEBYTECODE: '1', TMPDIR: box, RTW_STATE_DIR: join(box, 'statedir'), XDG_STATE_HOME: join(box, 'xdg') },
    encoding: 'utf8',
  });
  const log = existsSync(join(home, 'logs', 'sched.log')) ? readFileSync(join(home, 'logs', 'sched.log'), 'utf8') : '';
  const claimed = [...log.matchAll(/DRY would claim #(\d+)/g)].map((m) => Number(m[1]));
  return { status: r.status, stderr: r.stderr, claimed };
}

test('allowlisted non-owner author is claimed, non-allowlisted author is not', (t) => {
  const r = runSched(t, { allowlist: 'owner, guest' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.claimed.includes(7), 'allowlisted guest issue #7 not claimed: ' + r.claimed);
  assert.ok(r.claimed.includes(9), 'owner issue #9 not claimed: ' + r.claimed);
  assert.ok(!r.claimed.includes(8), 'non-allowlisted stranger issue #8 was claimed: ' + r.claimed);
});

test('unset allowlist defaults to RT_OWNER only', (t) => {
  const r = runSched(t, { allowlist: undefined });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.claimed, [9]);
});
