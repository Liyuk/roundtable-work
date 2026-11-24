// Chief DECISION first-line parsing (bin/rt-decision-parse) and the corrective Chief wake in rt-work.sh. No network; fake agent and gh only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const PARSER = join(hostDir, 'bin', 'rt-decision-parse');
const SKIP = new Set(['releases', 'test', 'deploy', 'config.env', 'state', 'logs', 'locks', 'status.tsv', 'chief-prompt.md', 'policy.md', 'rt-work.sh']);
const CORRECTIVE = 'which is not valid. Rewrite DECISION so line 1 is exactly one of';

// Runs the parser on a DECISION file holding `text`; returns stdout, exit status and the file afterwards.
function parse(t, text) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-dec-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'DECISION');
  writeFileSync(file, text);
  const r = spawnSync(PARSER, [file], { encoding: 'utf8' });
  return { out: r.stdout, status: r.status, file: readFileSync(file, 'utf8') };
}

const VARIANTS = [
  ['done', 'done'],
  ['DECISION: done', 'done'],
  ['decision=done', 'done'],
  ['**done**', 'done'],
  ['decision done', 'done'],
  ['Decision: **Done**', 'done'],
  ['decisiondone', 'done'],
  ['done.', 'done'],
  ['  `wait`  ', 'wait'],
  ['ask: credentials', 'ask'],
  ['continue', 'continue'],
  ['stop: budget used up', 'stop'],
  ['_out-of-scope_', 'out-of-scope'],
  ['DECISION: Decompose — too big', 'decompose'],
  ['no-pr', 'done'],
  ['decision: no-pr', 'done'],
  ['doneness', null],
  ['donedone', null],
  ['waiting for CI', null],
  ['', null],
];

test('A1: the parser maps each first-line variant to its verb, or prints nothing and exits 1', (t) => {
  assert.ok(VARIANTS.length >= 12);
  for (const [line, verb] of VARIANTS) {
    const r = parse(t, `${line}\nreason\n`);
    if (verb === null) {
      assert.equal(r.out, '', `unexpected output for ${JSON.stringify(line)}`);
      assert.equal(r.status, 1, `exit status for ${JSON.stringify(line)}`);
    } else {
      assert.equal(r.out, `${verb}\n`, `verb for ${JSON.stringify(line)}`);
      assert.equal(r.status, 0, `exit status for ${JSON.stringify(line)}`);
    }
  }
});

test('A2: a bare no-pr first line maps to done and rewrites the file so line 2 starts with no-pr', (t) => {
  const r = parse(t, 'no-pr\nverified against main\nsummary line\n');
  assert.equal(r.out, 'done\n');
  assert.equal(r.status, 0);
  const lines = r.file.split('\n');
  assert.equal(lines[0], 'done');
  assert.match(lines[1], /^no-pr/);
  assert.equal(lines[1], 'no-pr verified against main');
  assert.equal(lines[2], 'summary line');
});

// Sandbox: deployed rt-work.sh next to the shipped prompts; RT_HOME holds the copied host scripts and a fake agent.
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rt-decwake-'));
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
  chmodSync(join(rt, 'bin', 'rt-decision-parse'), 0o755);
  const fakebin = join(dir, 'fakebin');
  mkdirSync(fakebin);
  writeFileSync(join(fakebin, 'gh'), FAKE_GH, { mode: 0o755 });
  writeFileSync(join(fakebin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(rt, 'wt', '521', '.roundtable', 'state'), { recursive: true });
  writeFileSync(join(dir, 'steps'), '');
  return { dir, src, rt, fakebin };
}

// The stub repo has no open PR: `gh pr list` prints nothing; the other lists print an empty JSON.
const FAKE_GH = '#!/usr/bin/env bash\necho "$*" >>"$FAKE_GH_LOG"\ncase "$1 $2" in "pr list") ;; *list) echo "[]";; view) echo "{}";; esac\n';
// Fake Chief: wake N writes line N of $STEPS into DECISION; a step ending in " STOP" also touches the STOP file.
const FAKE_AGENT = `#!/usr/bin/env bash
case "$1" in --harness) echo pi;; --model) echo tokenarmy/fake;; chief)
  n=$(( $(cat "$CALLS" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$CALLS"
  cat >"$PROMPTS/wake$n.txt"
  cat "$RT_HOME/wt/521/.roundtable/state/DECISION" >"$PROMPTS/decision$n.txt" 2>/dev/null || true
  step=$(sed -n "\${n}p" "$STEPS")
  printf '%b\\n' "\${step% STOP}" >"$RT_HOME/wt/521/.roundtable/state/DECISION"
  case "$step" in *" STOP") touch "$RT_HOME/STOP";; esac;;
esac
`;

function runWorker(t, steps) {
  const sb = sandbox(t);
  writeFileSync(join(sb.dir, 'steps'), steps.join('\n') + '\n');
  mkdirSync(join(sb.dir, 'prompts'));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(RT_|GH_|GITHUB_)/.test(k))),
    PATH: `${sb.fakebin}:${process.env.PATH}`,
    RT_HOME: sb.rt,
    RT_GH_REAL: join(sb.fakebin, 'gh'),
    RT_REPO_DIR: sb.rt,
    STEPS: join(sb.dir, 'steps'),
    CALLS: join(sb.dir, 'calls'),
    PROMPTS: join(sb.dir, 'prompts'),
    FAKE_GH_LOG: join(sb.dir, 'gh.log'),
  };
  const r = spawnSync('bash', [join(sb.src, 'rt-work.sh'), '521'], { cwd: sb.src, env, encoding: 'utf8', timeout: 60_000 });
  const log = readFileSync(join(sb.rt, 'logs', 'workers.log'), 'utf8');
  const gh = readFileSync(env.FAKE_GH_LOG, 'utf8');
  const calls = Number(readFileSync(env.CALLS, 'utf8'));
  const prompt = (n) => readFileSync(join(sb.dir, 'prompts', `wake${n}.txt`), 'utf8');
  const seen = (n) => readFileSync(join(sb.dir, 'prompts', `decision${n}.txt`), 'utf8');
  const history = join(sb.rt, 'wt', '521', '.roundtable', 'state', 'supervisor-history');
  const notes = !existsSync(history) ? '' : readdirSync(history).map((f) => readFileSync(join(history, f), 'utf8')).join('\n');
  return { r, log, gh, calls, prompt, seen, notes };
}

test('A5: a stub Chief writing "DECISION: done" reaches handle_done (PR lookup on the done path)', (t) => {
  const { r, log, gh, notes } = runWorker(t, ['DECISION: done', 'continue STOP']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(log, /wake 1 end rc=0 decision=done/);
  assert.match(gh, /pr list .*--head rt\/521-pi/);
  assert.match(notes, /DECISION was done but no open PR from rt\/521-pi exists/);
});

test('A4: an unrecognised first line triggers exactly one corrective Chief wake in the same session, without counting noprog', (t) => {
  const { r, log, calls, prompt, seen } = runWorker(t, ['doneness', 'doneness STOP']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(calls, 2, 'one bad wake and exactly one corrective wake');
  assert.ok(prompt(2).startsWith('The first line of DECISION was `doneness`, ' + CORRECTIVE), 'wake 2 carries the corrective paragraph');
  assert.ok(prompt(2).includes('`continue wait ask done stop decompose out-of-scope`'));
  assert.ok(!prompt(1).includes(CORRECTIVE), 'wake 1 is the normal prompt');
  assert.equal(seen(1), '', 'wake 1 starts with no DECISION file');
  assert.equal(seen(2).split('\n')[0], 'doneness', 'wake 2 still sees the bad DECISION to rewrite');
  assert.doesNotMatch(log, /no progress in 2 consecutive wakes/, 'the wake pair counts as one no-progress wake');
  assert.match(log, /wake 2 end rc=0 decision=none/);
});

test('A6: the helper uses no bash-4-only expansion (macOS CI runs bash 3.2)', () => {
  const src = readFileSync(PARSER, 'utf8');
  assert.doesNotMatch(src, /\$\{[^}]*(,,|\^\^)/);
  assert.doesNotMatch(src, /\bdeclare -A\b|\bmapfile\b|\breadarray\b/);
});
