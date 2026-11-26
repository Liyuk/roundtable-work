// rt-work ask path (#553): a direction ask with a recommendation in its options is resolved by chief through the ask policy
// (no rt-decide call); scope asks (goal changes) are never policy-resolved and still call rt-decide;
// credentials/destructive/production still go to the owner.
// Fixtures only: fake gh, fake chief agent, fake rt-decide. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['releases', 'test', 'deploy', 'config.env', 'state', 'logs', 'locks', 'status.tsv']);
const FAKE_GH = `#!/usr/bin/env bash
echo "$1 $2" >> "$FAKE_GH_LOG"
case "$2" in list) echo '[]';; view) echo '{}';; esac
`;
// Chief wake 1 writes the DECISION under test (RT_HOME/DECISION.in); wake 2 stops the loop.
const FAKE_AGENT = `#!/usr/bin/env bash
case "$1" in --harness) echo pi;; --model) echo tokenarmy/fake;; chief)
  cat >/dev/null
  w=$(cat "$RT_HOME/wakes" 2>/dev/null || echo 0); w=$((w+1)); echo "$w" >"$RT_HOME/wakes"
  if [ "$w" = 1 ]; then cp "$RT_HOME/DECISION.in" "$2/.roundtable/state/DECISION"; else touch "$RT_HOME/STOP"; fi;;
esac
`;
const FAKE_DECIDE = `#!/usr/bin/env bash
echo called >> "$RT_HOME/decide-calls.log"
printf 'DECIDE: ask-owner\\nthe owner decides\\n'
`;

// Layout: <base>/host is RT_HOME (copied), <base>/runtime sits beside it so host/bin reaches runtime/lib as in the repo.
function runWorker(t, decision) {
  const base = mkdtempSync(join(tmpdir(), 'rt-ask-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'host');
  mkdirSync(root);
  for (const name of readdirSync(hostDir)) {
    if (!SKIP.has(name)) cpSync(join(hostDir, name), join(root, name), { recursive: true });
  }
  cpSync(join(hostDir, '..', 'runtime'), join(base, 'runtime'), { recursive: true });
  cpSync(join(hostDir, 'config.env.example'), join(root, 'config.env'));
  writeFileSync(join(root, 'bin', 'rt-agent'), FAKE_AGENT, { mode: 0o755 });
  writeFileSync(join(root, 'bin', 'rt-decide'), FAKE_DECIDE, { mode: 0o755 });
  writeFileSync(join(root, 'DECISION.in'), decision);
  const fakebin = join(base, 'fakebin');
  mkdirSync(fakebin);
  writeFileSync(join(fakebin, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(fakebin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(root, 'wt', '521', '.roundtable', 'state'), { recursive: true });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RT_|GH_|GITHUB_)/.test(k)));
  const env = {
    ...inherited,
    PATH: `${fakebin}:${process.env.PATH}`,
    RT_HOME: root,
    RT_GH_REAL: join(fakebin, 'gh'),
    RT_REPO_DIR: base,
    FAKE_GH_LOG: join(base, 'gh.log'),
  };
  const r = spawnSync('bash', [join(root, 'rt-work.sh'), '521'], { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  const log = existsSync(join(root, 'logs', 'workers.log')) ? readFileSync(join(root, 'logs', 'workers.log'), 'utf8') : '';
  const decided = existsSync(join(root, 'decide-calls.log'));
  const supervisor = join(root, 'wt', '521', '.roundtable', 'state', 'SUPERVISOR.md');
  return { r, log, decided, supervisor: existsSync(supervisor) ? readFileSync(supervisor, 'utf8') : '' };
}

test('a scope ask (goal change) with a recommendation is NOT resolved by chief: rt-decide is called', (t) => {
  const { r, log, decided, supervisor } = runWorker(t, 'ask\nscope\nWhich option?\noptions: keep A | take B\nrecommendation: keep A\n');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(decided, true);
  assert.doesNotMatch(log, /Chief resolved/);
  assert.doesNotMatch(supervisor, /keep A/);
});

test('a direction ask with a recommendation is also resolved by chief', (t) => {
  const { decided, supervisor } = runWorker(t, 'ask\ndirection\nWhich way?\noptions: x | y\nrecommendation: y\n');
  assert.equal(decided, false);
  assert.match(supervisor, /\by\b/);
});

test('credentials, destructive and production asks still go to the owner, with or without a recommendation', (t) => {
  for (const cat of ['credentials', 'destructive', 'production']) {
    const { decided, log } = runWorker(t, `ask\n${cat}\nApprove?\noptions: a | b\nrecommendation: a\n`);
    assert.equal(decided, false, cat);
    assert.match(log, new RegExp(`asked owner \\(${cat}\\)`));
  }
});

test('an in-scope ask without a recommendation still goes to rt-decide', (t) => {
  const { decided, log } = runWorker(t, 'ask\nscope\nWhich option?\n');
  assert.equal(decided, true);
  assert.match(log, /calling rt-decide/);
});
