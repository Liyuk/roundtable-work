// Main-red re-run (#539): the scheduler re-runs failed jobs once per red sha through the real gh, and logs success only when the re-run is accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sched = join(dirname(fileURLToPath(import.meta.url)), '..', 'rt-sched.py');
const RED_RUN = '[{"conclusion":"failure","headSha":"abcdef1234567890","status":"completed","databaseId":42}]';

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "run list") echo '${RED_RUN}';;
  "run rerun") if [ "$FAKE_RERUN_RC" != 0 ]; then echo "rerun refused" >&2; fi; exit "$FAKE_RERUN_RC";;
esac
`;

const PY = `import importlib.util, sys
spec = importlib.util.spec_from_file_location("rt_sched", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
s = m.Sched(False, True)
s.check_main(); s.check_main()
`;

function runTwoCycles(t, rerunRc) {
  const home = mkdtempSync(join(tmpdir(), 'rt-mainrerun-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const fakegh = join(home, 'fakegh');
  writeFileSync(fakegh, FAKE_GH, { mode: 0o755 });
  writeFileSync(join(home, 'config.env'), '');
  const log = join(home, 'gh.log');
  const r = spawnSync('python3', ['-c', PY, sched], {
    env: {
      ...process.env,
      RT_HOME: home, RT_GH_REAL: fakegh, FAKE_GH_LOG: log, FAKE_RERUN_RC: String(rerunRc), PYTHONDONTWRITEBYTECODE: '1',
    },
    encoding: 'utf8',
  });
  const schedLog = join(home, 'logs', 'sched.log');
  const lines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);
  return { status: r.status, stderr: r.stderr, sched: lines(schedLog), gh: lines(log) };
}

test('main-red re-run uses the real gh and logs WARN with no success line when the re-run fails (#539)', (t) => {
  const { status, stderr, sched: out, gh } = runTwoCycles(t, 1);
  assert.equal(status, 0, stderr);
  assert.ok(out.some((l) => l.includes('WARN main CI rerun of run 42 failed (rc=1): rerun refused')), out.join('\n'));
  assert.ok(!out.some((l) => l.includes('re-ran failed jobs')), out.join('\n'));
  assert.equal(gh.filter((l) => l.startsWith('run rerun')).length, 1, gh.join('\n'));
});

test('main-red re-run logs success once per head SHA when the re-run is accepted (#539)', (t) => {
  const { status, stderr, sched: out, gh } = runTwoCycles(t, 0);
  assert.equal(status, 0, stderr);
  assert.equal(out.filter((l) => l.includes('re-ran failed jobs once (run 42)')).length, 1, out.join('\n'));
  assert.ok(!out.some((l) => l.includes('WARN main CI rerun')), out.join('\n'));
  assert.equal(gh.filter((l) => l.startsWith('run rerun')).length, 1, gh.join('\n'));
});
