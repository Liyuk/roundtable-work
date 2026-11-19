// rt-tmpclean prunes only this instance's temp dir and state lock dir; a second instance's files are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rt-tmpclean');
const HOUR = 3600_000;

// Creates an entry with its mtime set `ageMs` in the past (0 = fresh).
function entry(path, ageMs) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'x');
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

function instance(root, name) {
  const home = join(root, name);
  return {
    tmp: join(home, 'tmp'),
    rtHome: join(home, 'rt'),
    state: join(home, 'state'),
    locks: join(home, 'state', 'locks'),
  };
}

test('one instance cleanup prunes its own old files and leaves the other instance untouched', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rt-tmpclean-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const a = instance(root, 'a');
  const b = instance(root, 'b');
  const ownOld = [entry(join(a.tmp, 'rt-lock-1'), HOUR), entry(join(a.tmp, 'rt-renewal-1'), HOUR), entry(join(a.locks, 'old-lock'), 3 * HOUR)];
  const ownFresh = [entry(join(a.tmp, 'rt-hard-2'), 0), entry(join(a.locks, 'fresh-lock'), 0)];
  const rtHomeLive = [entry(join(a.rtHome, 'locks', 'old-lock'), 3 * HOUR)];
  const other = [entry(join(b.tmp, 'rt-lock-1'), HOUR), entry(join(b.tmp, 'rt-recovery-1'), HOUR), entry(join(b.locks, 'old-lock'), 3 * HOUR)];

  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: a.tmp, RT_HOME: a.rtHome, RTW_STATE_DIR: a.state };
  const r = spawnSync('sh', [script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);

  for (const p of ownOld) assert.equal(existsSync(p), false, `old own file should be pruned: ${p}`);
  for (const p of ownFresh) assert.equal(existsSync(p), true, `fresh own file should stay: ${p}`);
  for (const p of rtHomeLive) assert.equal(existsSync(p), true, `RT_HOME/locks entry must never be pruned: ${p}`);
  for (const p of other) assert.equal(existsSync(p), true, `other instance file must not be touched: ${p}`);
});

test('without RT_HOME or RTW_STATE_DIR the lock dir is $HOME/.local/state/roundtable/locks', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rt-tmpclean-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const oldLock = entry(join(home, '.local', 'state', 'roundtable', 'locks', 'old-lock'), 3 * HOUR);
  const r = spawnSync('sh', [script], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: join(root, 'tmp') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(oldLock), false);
});

test('XDG_STATE_HOME selects the lock dir', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'rt-tmpclean-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldLock = entry(join(root, 'xdg', 'roundtable', 'locks', 'old-lock'), 3 * HOUR);
  spawnSync('sh', [script], { env: { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), XDG_STATE_HOME: join(root, 'xdg') } });
  assert.equal(existsSync(oldLock), false);
});
