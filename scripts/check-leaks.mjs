import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const count = async (dir, match = () => true) =>
  (await readdir(dir).catch(() => [])).filter(match).length;
const snapshot = async () => ({
  tmp: await count(tmpdir(), (name) => name.startsWith('rt-')),
  state: await count(join(homedir(), '.local', 'state', 'roundtable')),
});

const before = await snapshot();
const run = spawnSync('npm', ['test'], { stdio: 'inherit' });
const after = await snapshot();
console.log(`rt-* in ${tmpdir()}: before ${before.tmp}, after ${after.tmp}`);
console.log(`entries in ~/.local/state/roundtable: before ${before.state}, after ${after.state}`);

const grew = [];
if (after.tmp > before.tmp) grew.push('system temp rt-* entries');
if (after.state > before.state) grew.push('~/.local/state/roundtable entries');
if (grew.length) {
  console.error(`LEAK: grew: ${grew.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('unchanged');
  process.exitCode = run.status ?? 1;
}
