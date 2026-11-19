// Chief and policy prompt selection: $RT_HOME override wins; otherwise the shipped copy next to rt-work.sh. No network; fake agent only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['releases', 'test', 'deploy', 'config.env', 'state', 'logs', 'locks', 'status.tsv', 'chief-prompt.md', 'policy.md', 'rt-work.sh']);

// Layout: `src/` holds the deployed script next to the shipped prompts; `rt/` is RT_HOME, which has no prompt files of its own.
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-prompt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, 'src');
  const rt = join(dir, 'rt');
  mkdirSync(src);
  mkdirSync(rt);
  for (const f of ['rt-work.sh', 'outbox-bridge.mjs', 'chief-prompt.md', 'policy.md']) cpSync(join(hostDir, f), join(src, f));
  for (const name of readdirSync(hostDir)) {
    if (!SKIP.has(name)) cpSync(join(hostDir, name), join(rt, name), { recursive: true });
  }
  cpSync(join(hostDir, 'config.env.example'), join(rt, 'config.env'));
  writeFileSync(join(rt, 'bin', 'rt-agent'), FAKE_AGENT, { mode: 0o755 });
  const fakebin = join(dir, 'fakebin');
  mkdirSync(fakebin);
  writeFileSync(join(fakebin, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(fakebin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(rt, 'wt', '521', '.roundtable', 'state'), { recursive: true });
  return { dir, src, rt, fakebin };
}

const FAKE_GH = '#!/usr/bin/env bash\ncase "$2" in list) echo "[]";; view) echo "{}";; esac\n';
// Fake agent: captures the Chief prompt from stdin, then stops the loop.
const FAKE_AGENT = `#!/usr/bin/env bash
case "$1" in --harness) echo pi;; --model) echo tokenarmy/fake;; chief) cat >"$PROMPT_OUT"; touch "$RT_HOME/STOP";; esac
`;

// Runs the deployed copy of rt-work.sh for issue 521 with RT_HOME set to the sandbox's rt/ dir.
function runWorker(t, { override } = {}) {
  const sb = sandbox(t);
  if (override !== undefined) writeFileSync(join(sb.rt, 'chief-prompt.md'), override);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RT_|GH_|GITHUB_)/.test(k))),
    PATH: `${sb.fakebin}:${process.env.PATH}`,
    RT_HOME: sb.rt,
    RT_GH_REAL: join(sb.fakebin, 'gh'),
    RT_REPO_DIR: sb.rt,
    PROMPT_OUT: join(sb.dir, 'prompt.txt'),
    FAKE_GH_LOG: join(sb.dir, 'gh.log'),
  };
  const r = spawnSync('bash', [join(sb.src, 'rt-work.sh'), '521'], { cwd: sb.src, env, encoding: 'utf8', timeout: 60_000 });
  const prompt = readFileSync(env.PROMPT_OUT, 'utf8');
  return { r, sb, prompt };
}

// Lines of the shipped file with no placeholder: each must appear verbatim in the rendered prompt.
const literalLines = (file) => readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 20 && !l.includes('__'));

test('AC4: with no chief-prompt.md in RT_HOME, the Chief wake renders the shipped host/chief-prompt.md', (t) => {
  const { r, prompt } = runWorker(t);
  assert.equal(r.status, 0, r.stderr);
  const shipped = join(hostDir, 'chief-prompt.md');
  const lines = literalLines(shipped);
  assert.ok(lines.length > 5);
  for (const l of lines) assert.ok(prompt.includes(l), `missing shipped line: ${l}`);
  assert.doesNotMatch(prompt, /__[A-Z_]+__/, 'placeholders left unsubstituted');
  assert.match(prompt, /\b521\b/);
});

test('AC4: with $RT_HOME/chief-prompt.md present, its content is rendered instead of the shipped copy', (t) => {
  const { r, prompt } = runWorker(t, { override: 'OVERRIDE-MARKER issue __N__\n' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(prompt, 'OVERRIDE-MARKER issue 521');
  for (const l of literalLines(join(hostDir, 'chief-prompt.md'))) assert.ok(!prompt.includes(l), `shipped line leaked: ${l}`);
});

test('AC3: with no policy.md in RT_HOME, the worktree policy is the shipped host/policy.md', (t) => {
  const { r, sb } = runWorker(t);
  assert.equal(r.status, 0, r.stderr);
  const policy = readFileSync(join(sb.rt, 'wt', '521', '.roundtable', 'policy.md'), 'utf8');
  for (const l of literalLines(join(hostDir, 'policy.md'))) assert.ok(policy.includes(l), `missing shipped policy line: ${l}`);
});
