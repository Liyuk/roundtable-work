// RT-P3 roster (#553): the host shell uses the seven standing roles, and every legacy alias maps to its canonical role.
// Fixtures only: fake pi on PATH, a scratch host copy with its own config.env. No network, no real harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLE_ALIASES, ROLES } from '../../runtime/lib/routing.mjs';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['releases', 'test', 'deploy', 'config.env', 'state', 'logs', 'locks', 'status.tsv']);
const MAIN = 'main-model';
const VERIFY = 'verify-model';
const FAKE_PI = `#!/usr/bin/env bash
echo "$(basename "$0") $*" >> "$FAKE_MODEL_LOG"
printf 'Verdict: pass\\nno findings\\n'
`;
const readLines = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : []);

// host/ copied as <base>/host (RT_HOME) next to <base>/runtime, so host/bin reaches runtime/lib as in the repo.
function sandbox(t) {
  const base = mkdtempSync(join(tmpdir(), 'rt-roster-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'host');
  mkdirSync(root);
  for (const name of readdirSync(hostDir)) {
    if (!SKIP.has(name)) cpSync(join(hostDir, name), join(root, name), { recursive: true });
  }
  cpSync(join(hostDir, '..', 'runtime'), join(base, 'runtime'), { recursive: true });
  writeFileSync(join(root, 'config.env'), `RT_HARNESS=pi\nRT_MODEL=${MAIN}\nRT_DECIDER_MODEL=${VERIFY}\nRT_XCHECK_MODEL=xcheck-model\n`);
  const fakebin = join(base, 'fakebin');
  mkdirSync(fakebin);
  writeFileSync(join(fakebin, 'pi'), FAKE_PI, { mode: 0o755 });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RT_|GH_|GITHUB_)/.test(k)));
  const env = { ...inherited, PATH: `${fakebin}:${process.env.PATH}`, RT_HOME: root, FAKE_MODEL_LOG: join(base, 'model.log') };
  const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: 30_000, ...opts });
  const wd = join(base, 'wd');
  mkdirSync(wd);
  const card = join(base, 'card.md');
  writeFileSync(card, 'assignment\n');
  return { root, wd, card, run, modelCalls: () => readLines(env.FAKE_MODEL_LOG) };
}

test('rt-agent --routing-facts lists exactly the seven standing roles', (t) => {
  const r = sandbox(t).run('bin/rt-agent', ['--routing-facts']);
  assert.equal(r.status, 0, r.stderr);
  const listed = [...r.stdout.matchAll(/^- ([a-z]+): /gm)].map((m) => m[1]).filter((name) => name !== 'harness');
  assert.deepEqual(listed, ROLES);
});

test('rt-agent --model gives each standing role its model; verifier and security use the decider model', (t) => {
  const { run } = sandbox(t);
  const modelOf = (role) => run('bin/rt-agent', ['--model', role]).stdout.trim();
  for (const role of ROLES) {
    const expected = role === 'verifier' || role === 'security' ? VERIFY : MAIN;
    assert.equal(modelOf(role), expected, role);
  }
});

test('every legacy alias in ROLE_ALIASES resolves to the model of its canonical role', (t) => {
  const { run } = sandbox(t);
  for (const [alias, role] of Object.entries(ROLE_ALIASES)) {
    const r = run('bin/rt-agent', ['--model', alias]);
    assert.equal(r.status, 0, `${alias}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), run('bin/rt-agent', ['--model', role]).stdout.trim(), alias);
  }
});

test('an unknown role name exits 2 in rt-agent and rt-delegate', (t) => {
  const { run, wd, card, modelCalls } = sandbox(t);
  assert.equal(run('bin/rt-agent', ['--model', 'nosuch']).status, 2);
  assert.equal(run('bin/rt-delegate', ['nosuch', card, wd]).status, 2);
  assert.deepEqual(modelCalls(), []);
});

test('rt-delegate accepts the seven roles and every legacy alias', (t) => {
  const { run, wd, card } = sandbox(t);
  for (const role of [...ROLES, ...Object.keys(ROLE_ALIASES)]) {
    const r = run('bin/rt-delegate', [role, card, wd]);
    assert.equal(r.status, 0, `${role}: ${r.stderr}`);
  }
});

test('a verifier call is a fresh session (no session, no edit tools) on the decider model; an alias routes the same way', (t) => {
  const { run, wd, modelCalls } = sandbox(t);
  const r = run('bin/rt-agent', ['decider', wd, join(wd, 'out.txt')], { input: 'judge this\n' });
  assert.equal(r.status, 0, r.stderr);
  const [call] = modelCalls();
  assert.match(call, /--model verify-model/);
  assert.match(call, /--no-session --exclude-tools edit,write/);
});
