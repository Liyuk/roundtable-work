// The scheduler heartbeat carries backlog, claimable and idle_cycles (integers) after the existing lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sched = join(dirname(fileURLToPath(import.meta.url)), '..', 'rt-sched.py');

// Fake gh (no network): every read returns an empty list except the open-issue list, so nothing is claimed.
// Two open issues: #1 is running (claimed, not backlog), #2 is held (unclaimed, backlog, not a candidate).
const FAKE_GH = `#!/usr/bin/env bash
case "$*" in *"issue list"*"--state open"*) echo '[{"number":1,"title":"a","body":"","labels":[{"name":"rt:running"}],"createdAt":"2026-01-01T00:00:00Z"},{"number":2,"title":"b","body":"","labels":[{"name":"rt:hold"}],"createdAt":"2026-01-01T00:00:00Z"}]';; *) echo '[]';; esac
`;

test('heartbeat carries integer backlog, claimable and idle_cycles after the existing lines', (t) => {
  const box = mkdtempSync(join(tmpdir(), 'rt-heartbeat-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const home = join(box, 'rt'), fx = join(box, 'fx'), tmp = join(box, 'tmp');
  for (const d of [home, fx, tmp]) mkdirSync(d);
  writeFileSync(join(fx, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(home, 'rt-work.sh'), '#!/usr/bin/env bash\n', { mode: 0o755 });
  writeFileSync(join(home, 'config.env'), 'RT_REPO=example/repo\nRT_OWNER=owner\nRT_WORKERS=0\n' +
    'RT_MAX_LOAD=100000\nRT_MIN_MEM_MB=0\nRT_MAX_MEM_PSI=100000\n');
  const r = spawnSync('python3', [sched, '--once'], {
    env: { ...process.env, RT_HOME: home, RT_GH_REAL: join(fx, 'gh'), FAKE_GH_LOG: join(fx, 'gh.log'), PYTHONDONTWRITEBYTECODE: '1',
      TMPDIR: tmp, RTW_STATE_DIR: join(box, 'statedir'), XDG_STATE_HOME: join(box, 'xdg') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = readFileSync(join(home, 'state', 'heartbeat'), 'utf8').split('\n').filter(Boolean);
  const keys = lines.map((l) => l.split('=')[0]);
  assert.deepEqual(keys, ['ts', 'epoch', 'pid', 'dry', 'slots', 'running', 'main_red', 'workers', 'backlog', 'claimable', 'idle_cycles']);
  const get = (k) => lines.find((l) => l.startsWith(k + '=')).slice(k.length + 1);
  assert.equal(get('backlog'), '1');
  assert.equal(get('claimable'), '0');
  assert.equal(get('idle_cycles'), '1');
});
