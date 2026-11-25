// rt-metrics counts failed GitHub reads from sched.log (#652). Fixture log only; the module is loaded, not run (no GitHub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("rt_metrics", sys.argv[1])
spec = importlib.util.spec_from_loader("rt_metrics", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)
parsed = mod.parse_sched_log(mod.Path(sys.argv[2]))
print(json.dumps([d.isoformat() for d in parsed["gh_read_fails"]]))
`;

test('each gh_read_fail line in sched.log is counted by rt-metrics', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-metrics-gh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'sched.log');
  writeFileSync(log, [
    '2026-11-16 10:00:00 CST rt-sched start pid=101 dry=False once=False workers=2 poll=30s',
    '2026-11-16 10:01:00 CST gh_read_fail gh issue list failed: boom',
    '2026-11-16 10:02:00 CST GitHub read failed: no new claims this cycle (1 candidate(s) wait)',
    '2026-11-16 10:03:00 CST gh_read_fail gh pr list failed: timed out after 60s',
  ].join('\n') + '\n');
  const r = spawnSync('python3', ['-c', PY, join(repo, 'host', 'bin', 'rt-metrics'), log], {
    env: { ...process.env, RT_HOME: dir, PYTHONDONTWRITEBYTECODE: "1" }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).length, 2, 'the two failed reads are counted; the claim-skip line is not a read failure');
});
