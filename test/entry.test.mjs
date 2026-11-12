// Regression tests for #61: the CLI entry guard must run main() when a script is invoked
// through a symlink, and must stay false when the module is only imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntry } from '../scripts/entry.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const scripts = join(repo, 'scripts');

// A scratch dir holding `repo` -> the real checkout (a /tmp-style directory symlink).
const links = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rtw-entry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(repo, join(dir, 'repo'), 'dir');
  return dir;
};
const target = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rtw-entry-target-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const run = (script, args, cwd) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd, timeout: 60_000 });

test('isEntry compares real paths on both sides', (t) => {
  const dir = links(t);
  const real = join(scripts, 'install.mjs');
  const url = pathToFileURL(real).href;
  symlinkSync(real, join(dir, 'install-link.mjs'));
  assert.equal(isEntry(url, real), true);
  assert.equal(isEntry(url, join(dir, 'repo', 'scripts', 'install.mjs')), true, 'directory symlink');
  assert.equal(isEntry(url, join(dir, 'install-link.mjs')), true, 'file symlink');
  assert.equal(isEntry(url, join(scripts, 'doctor.mjs')), false, 'a different script');
  assert.equal(isEntry(url, fileURLToPath(import.meta.url)), false, 'imported from a test');
  assert.equal(isEntry(url, undefined), false, 'no argv[1]');
  assert.equal(isEntry(url, ''), false, 'empty argv[1]');
  assert.equal(isEntry(url, join(dir, 'missing.mjs')), false, 'argv[1] that does not exist');
});

test('install.mjs runs main() through a directory symlink with --dry-run --json', (t) => {
  const dir = links(t);
  const r = run(join(dir, 'repo', 'scripts', 'install.mjs'), ['--target', target(t), '--dry-run', '--json'], dir);
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(r.stdout.trim(), '', 'must not exit 0 silently');
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.dryRun, true);
  assert.ok(plan.summary.create > 0);
});

test('install.mjs runs main() through a file symlink and from a symlinked cwd', (t) => {
  const dir = links(t);
  const out = target(t);
  symlinkSync(join(scripts, 'install.mjs'), join(dir, 'install-link.mjs'));
  const viaFile = run(join(dir, 'install-link.mjs'), ['--target', out, '--dry-run'], dir);
  assert.equal(viaFile.status, 0, viaFile.stderr);
  assert.match(viaFile.stdout, /Summary:/);
  // Relative argv[1] from inside the symlinked directory: the macOS /tmp case.
  const viaCwd = run(join('scripts', 'install.mjs'), ['--target', out, '--dry-run'], join(dir, 'repo'));
  assert.equal(viaCwd.status, 0, viaCwd.stderr);
  assert.match(viaCwd.stdout, /Summary:/);
});

test('build-site.mjs and validate-site.mjs run main() through a symlink', (t) => {
  const dir = links(t);
  const script = join(dir, 'repo', 'scripts', 'build-site.mjs');
  // --check is silent when site/ is current, so it alone cannot prove main() ran.
  const check = run(script, ['--check'], dir);
  assert.equal(check.status, 0, check.stderr);
  // site/ is current (checked above), so a plain build writes nothing and reports each file.
  const build = run(script, [], dir);
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout, /site\/index\.html is up to date/, 'build-site must not exit 0 silently');
  const validate = run(join(dir, 'repo', 'scripts', 'validate-site.mjs'), [], dir);
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /Site validation passed/);
});

test('preview-site.mjs starts its server through a symlink', async (t) => {
  const dir = links(t);
  const child = spawn(process.execPath, [join(dir, 'repo', 'scripts', 'preview-site.mjs')], {
    cwd: dir, env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const out = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`no output in time: ${buf}`)), 20_000);
    child.stdout.on('data', (d) => { buf += d; if (/Previewing/.test(buf)) { clearTimeout(timer); resolve(buf); } });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code} before listening: ${buf}`)); });
  });
  assert.match(out, /Previewing site\/ at http:\/\/[^/\s]+:\d+\//);
});

test('importing the scripts does not run their main()', () => {
  const code = ['install.mjs', 'validate-site.mjs', 'build-site.mjs', 'preview-site.mjs']
    .map((f) => `await import(${JSON.stringify(pathToFileURL(join(scripts, f)).href)});`).join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});
