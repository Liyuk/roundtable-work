// Bare-gh lint (#539): scheduler and worker scripts must reach GitHub through the real CLI variable, never a bare `gh` on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PY_BARE_GH = /\[\s*["']gh["']/;
const SH_BARE_GH = /(^|[;&|(`]|\$\()\s*gh\s/;

const files = [
  'rt-sched.py', 'rt-work.sh', 'rt-loop.sh',
  ...readdirSync(join(hostDir, 'bin')).filter((f) => f !== 'gh').map((f) => join('bin', f)),
];

function bareGh(path, text) {
  const py = path.endsWith('.py') || /python/.test(text.split('\n', 1)[0]);
  return text.split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => !line.trimStart().startsWith('#'))
    .filter(({ line }) => (py ? PY_BARE_GH.test(line) : SH_BARE_GH.test(line.replace(/\s#.*$/, ''))))
    .map(({ n }) => `${path}:${n}`);
}

test('no scheduler or worker script calls a bare gh executable (#539)', () => {
  const offenders = files.flatMap((f) => bareGh(f, readFileSync(join(hostDir, f), 'utf8')));
  assert.deepEqual(offenders, []);
});

test('the bare-gh lint flags a bare gh call and ignores the real CLI variable (#539)', () => {
  assert.match('subprocess.run(["gh", "run"', PY_BARE_GH);
  assert.doesNotMatch('subprocess.run([GH, "run"', PY_BARE_GH);
  assert.match('  gh run rerun 1', SH_BARE_GH);
  assert.doesNotMatch('"$GH" run rerun 1', SH_BARE_GH);
  assert.doesNotMatch('# gh run', SH_BARE_GH);
});
