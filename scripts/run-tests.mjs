import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'rt-test-'));
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RT_NOTIFY_WEBHOOK_'))),
  RTW_STATE_DIR: join(root, 'state'),
  XDG_STATE_HOME: join(root, 'xdg'),
  TMPDIR: root,
};
try {
  const tests = spawnSync(process.execPath, ['--test'], { stdio: 'inherit', env });
  const status = tests.status ?? 1;
  if (status !== 0) process.exitCode = status;
  else {
    const check = spawnSync(process.execPath, ['scripts/check.mjs'], { stdio: 'inherit', env });
    process.exitCode = check.status ?? 1;
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
