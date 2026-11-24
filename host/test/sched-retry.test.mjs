// Scheduler crash backoff and transient-hold retry (#647). The checks live in sched_retry_test.py (fake Popen, no GitHub).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'sched_retry_test.py');

test('rt-sched: crashes back off 15/60/240 min across restarts, the 4th alerts and blocks; transient merge holds are swept', () => {
  const r = spawnSync('python3', [script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
