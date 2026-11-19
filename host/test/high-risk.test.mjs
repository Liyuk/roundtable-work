// Gate 2 trigger (#563): host/bin/rt-risk prints one reason line for a high-risk diff, nothing for a low-risk one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const risk = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'rt-risk');
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

// Base commit, then one work commit adding `files` (path -> line count). Returns rt-risk's stdout.
function trigger(t, files, title = '[T] ordinary change') {
  const wt = mkdtempSync(join(tmpdir(), 'rt-risk-'));
  t.after(() => rmSync(wt, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', wt, ...GIT, ...a], { encoding: 'utf8' });
  git('init', '-q');
  writeFileSync(join(wt, 'README.md'), 'base\n');
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  for (const [path, lines] of Object.entries(files)) {
    mkdirSync(join(wt, dirname(path)), { recursive: true });
    writeFileSync(join(wt, path), 'line\n'.repeat(lines));
  }
  git('add', '-A'); git('commit', '-q', '-m', 'work');
  const r = spawnSync(risk, [wt, base, title], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('low-risk change (small, ordinary path) gets no trigger reason: one review pass', (t) => {
  assert.equal(trigger(t, { 'docs/notes.md': 5 }), '');
});

test('a change to the existing high-risk paths triggers Gate 2', (t) => {
  assert.match(trigger(t, { 'scripts/check.mjs': 1 }), /scripts/);
  assert.match(trigger(t, { 'templates/delivery.md': 1 }), /templates/);
});

test('high-risk classes (auth, network, secrets, external input, deployment) trigger Gate 2', (t) => {
  assert.match(trigger(t, { 'src/auth/login.mjs': 1 }), /auth/);
  assert.match(trigger(t, { 'host/network/relay.mjs': 1 }), /network/);
  assert.match(trigger(t, { 'host/proxy/relay.mjs': 1 }), /proxy/);
  assert.match(trigger(t, { 'host/secrets.env.example': 1 }), /secret/);
  assert.match(trigger(t, { 'host/intake/parse.mjs': 1 }), /intake/);
  assert.match(trigger(t, { 'host/deploy/install.sh': 1 }), /deploy/);
});

test('high blast radius (>400 changed lines) triggers Gate 2', (t) => {
  assert.match(trigger(t, { 'docs/big.md': 401 }), /401 changed lines \(>400\)/);
  assert.equal(trigger(t, { 'docs/big.md': 400 }), '');
});

test('an I18N issue title triggers Gate 2', (t) => {
  assert.match(trigger(t, { 'docs/notes.md': 1 }, '[I18N] translate page'), /I18N/);
});
