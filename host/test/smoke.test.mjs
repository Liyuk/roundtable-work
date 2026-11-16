// Host smoke suite: the imported runtime under fake gh / fake pi / fake codex. No network, no real GitHub, dry-run only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// Not runtime: the deploy tool and its tests, the releases output, and any live state or real config.
const SKIP = new Set(['releases', 'test', 'deploy', 'config.env', 'state', 'logs', 'locks', 'status.tsv']);
const READ_VERBS = new Set(['issue list', 'issue view', 'pr list', 'pr view', 'pr checks', 'pr diff', 'run list', 'run view']);

const FAKE_GH = `#!/usr/bin/env bash
echo "$1 $2" >> "$FAKE_GH_LOG"
case "$2" in list) echo '[]';; view) echo '{}';; esac
`;
// Fake model: logs argv; a review-style prompt (last argument mentions "review") gets a Verdict line first.
const FAKE_MODEL = `#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$FAKE_MODEL_LOG"
case "\${@: -1}" in *review*) printf 'Verdict: pass\\nno findings\\n';; *) printf '# Delivery card\\nstatus: complete\\n';; esac
`;

const readLines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'rt-smoke-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of readdirSync(hostDir)) {
    if (!SKIP.has(name)) cpSync(join(hostDir, name), join(root, name), { recursive: true });
  }
  cpSync(join(hostDir, 'config.env.example'), join(root, 'config.env'));
  const fakebin = join(root, 'fakebin');
  mkdirSync(fakebin);
  for (const [name, body] of [['gh', FAKE_GH], ['pi', FAKE_MODEL], ['codex', FAKE_MODEL]]) {
    writeFileSync(join(fakebin, name), body, { mode: 0o755 });
  }
  // Drop inherited RT_* (live config) and GH_/GITHUB_* (tokens) so only the sandbox config applies.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RT_|GH_|GITHUB_)/.test(k)));
  const env = {
    ...inherited,
    PATH: `${fakebin}:${process.env.PATH}`,
    RT_HOME: root,
    RT_GH_REAL: join(fakebin, 'gh'),
    FAKE_GH_LOG: join(root, 'gh-calls.log'),
    FAKE_MODEL_LOG: join(root, 'model-calls.log'),
    PYTHONDONTWRITEBYTECODE: '1',
  };
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, ...opts });
  return {
    root,
    run,
    ghCalls: () => readLines(env.FAKE_GH_LOG),
    modelCalls: () => readLines(env.FAKE_MODEL_LOG),
  };
}

test('rt-sched --dry-run --once exits 0 and makes only GitHub reads', (t) => {
  const { run, ghCalls } = sandbox(t);
  const r = run('python3', ['rt-sched.py', '--dry-run', '--once']);
  assert.equal(r.status, 0, r.stderr);
  const calls = ghCalls();
  assert.ok(calls.length > 0, 'the scheduler should query gh through the fake');
  for (const c of calls) assert.ok(READ_VERBS.has(c), `non-read gh call in dry-run: ${c}`);
});

test('rt-agent --check exits 0 with a model for every role', (t) => {
  const r = sandbox(t).run('bin/rt-agent', ['--check']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rt-agent --check: ok \(harness pi/);
});

test('rt-gate0 --scan-text fails on a non-documentation IPv4 and passes clean text', (t) => {
  const { root, run } = sandbox(t);
  // Built at runtime so this fixture does not itself trip the Gate 0 scan of host/.
  const fakeIp = [10, 0, 0, 1].join('.');
  writeFileSync(join(root, 'leak.txt'), `backend at ${fakeIp}\n`);
  writeFileSync(join(root, 'clean.txt'), 'nothing private here\n');
  const bad = run('bin/rt-gate0', ['--scan-text', 'leak.txt']);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /IPv4 address/);
  assert.equal(run('bin/rt-gate0', ['--scan-text', 'clean.txt']).status, 0);
});

test('status.sh exits 0 on an empty state', (t) => {
  const r = sandbox(t).run('bash', ['status.sh']);
  assert.equal(r.status, 0, r.stderr);
});

test('rt-agent reviewer call goes through fake pi and returns its Verdict line', (t) => {
  const { root, run, modelCalls } = sandbox(t);
  mkdirSync(join(root, 'wd'));
  const out = join(root, 'review.out');
  const r = run('bin/rt-agent', ['reviewer', join(root, 'wd'), out], { input: 'please review this change\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(out, 'utf8').split('\n')[0], 'Verdict: pass');
  assert.ok(modelCalls().some((l) => l.startsWith('pi -p --model tokenarmy/claude-haiku-5-5')));
});
