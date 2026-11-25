// Worker-side internal retries (#647). Runs the real host/rt-work.sh in a temp RT_HOME against a real git worktree and
// bare origin; only model, gate, merge, CI and GitHub seams are stubbed (fake gh, outbox bridge that logs writes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const N = '647';

// Fake stage runner: `chief` runs the per-wake script $FAKE/wake-<k>.sh (default: write DECISION done).
// Sequenced stub: the n-th call returns line n of $FAKE/<name>.seq (the last line repeats).
const NTH = `nth(){ c=$(( $(cat "$FAKE/$1.n" 2>/dev/null || echo 0) + 1 )); echo "$c" >"$FAKE/$1.n"; v=$(sed -n "\${c}p" "$FAKE/$1.seq" 2>/dev/null); [ -n "$v" ] || v=$(tail -1 "$FAKE/$1.seq"); echo "$v"; }
`;
const STAGE = `#!/usr/bin/env bash
${NTH}case "$1" in
  chief)
    cat >/dev/null; WT="$6"; k=$(( $(cat "$FAKE/wake.n" 2>/dev/null || echo 0) + 1 )); echo "$k" >"$FAKE/wake.n"
    if [ -f "$FAKE/wake-$k.sh" ]; then WT="$WT" bash "$FAKE/wake-$k.sh"
    else mkdir -p "$WT/.roundtable/state"; printf 'done\\nsummary\\n' >"$WT/.roundtable/state/DECISION"; fi;;
  ci-watch) : >"$3"; exit 0;;
  *) echo "unexpected stage $1" >&2; exit 9;;
esac
`;
const GATE0 = `#!/usr/bin/env bash
${NTH}[ "$1" = --scan-text ] && exit 0
if [ "$(nth g0)" = fail ]; then echo 'FAILED_CHECKS: tests'; echo '[FAIL] tests'; exit 1; fi
echo '[PASS] tests'
`;
const SYNC = `#!/usr/bin/env bash
${NTH}if [ "$(nth sync)" = conflict ]; then echo 'SYNC: conflict origin/main'; else echo 'SYNC: uptodate'; fi
`;
const MERGE = `#!/usr/bin/env bash
${NTH}rc=$(nth merge)
if [ "$rc" = 0 ]; then echo 'MERGED: PR #5 sha=abc1234'; else echo "REFUSE[sync]: rt-merge test rc=$rc"; fi
exit "$rc"
`;
// Gate 1 stand-in: records a passing verdict for the current tree, the way rt-delegate reviewer does.
const DELEGATE = `#!/usr/bin/env bash
printf '%s\\t%s\\tstub\\tpass\\n' "$(date -Is)" "$(git -C "$WT" rev-parse 'HEAD^{tree}')" >>"$WT/.roundtable/state/reviews.log"
echo 'Verdict: pass'
`;
const SIMPLE = { 'rt-agent': '#!/usr/bin/env bash\ncase "$1" in --harness) echo pi;; --model) echo stub-model;; esac\n',
  'rt-xcheck': '#!/usr/bin/env bash\necho "XCHECK: skipped"\n', 'rt-decide': '#!/usr/bin/env bash\necho "DECIDE: stop"\n' };
// Fake gh (RT_GH_REAL): answers the reads the worker makes; PR head is the worktree HEAD.
const GH = `#!/usr/bin/env bash
echo "$*" >>"$FAKE/gh.log"
if [ "$1 $2" = "pr list" ] && [[ "$*" == *--head* ]]; then printf '5\\tfalse\\t%s\\n' "$(git -C "$WT" rev-parse HEAD)"; fi
`;
// Outbox bridge stand-in: every label/comment write is appended to the bridge log (argv, and the comment body).
const BRIDGE = `import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(4);
const body = args[0] === 'comment' ? ' BODY=' + JSON.stringify(readFileSync(args[2], 'utf8')) : '';
appendFileSync(process.env.FAKE_BRIDGE_LOG, JSON.stringify(args) + body + '\\n');
`;

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// A bare origin with main and rt/647-pi, a worktree for issue 647 at $RT_HOME/wt/647, and the stubs in $RT_HOME/bin.
function setup(t, { seq = {}, wakes = {}, env = {} }) {
  const box = mkdtempSync(join(tmpdir(), 'rt-internal-retry-'));
  t.after(() => rmSync(box, { recursive: true, force: true }));
  const home = join(box, 'rt'), fake = join(box, 'fake'), repo = join(box, 'roundtable-work'), origin = join(box, 'origin.git');
  mkdirSync(home); mkdirSync(fake);
  git(box, 'init', '-q', '--bare', origin);
  git(box, 'init', '-q', '-b', 'main', repo);
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'base');
  git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'checkout', '-q', '-b', `rt/${N}-pi`); git(repo, 'push', '-q', '-u', 'origin', `rt/${N}-pi`); git(repo, 'checkout', '-q', 'main');
  mkdirSync(join(home, 'wt'));
  git(repo, 'worktree', 'add', '-q', join(home, 'wt', N), `rt/${N}-pi`);
  // RT_HOME = a copy of the host scripts; the stubs replace only the seams listed above.
  cpSync(join(hostDir, 'bin'), join(home, 'bin'), { recursive: true });
  cpSync(join(hostDir, 'rt-work.sh'), join(home, 'rt-work.sh'));
  cpSync(join(hostDir, 'chief-prompt.md'), join(home, 'chief-prompt.md'));
  writeFileSync(join(home, 'outbox-bridge.mjs'), BRIDGE);
  writeFileSync(join(home, 'config.env'), `RT_REPO=example/repo\nRT_OWNER=owner\nRT_AUTOMERGE=1\nRT_LENIENT=0\n`);
  const stubs = { 'rt-stage-run': STAGE, 'rt-gate0': GATE0, 'rt-sync-branch': SYNC, 'rt-merge': MERGE, 'rt-delegate': DELEGATE, ...SIMPLE };
  for (const [name, body] of Object.entries(stubs)) { writeFileSync(join(home, 'bin', name), body); chmodSync(join(home, 'bin', name), 0o755); }
  writeFileSync(join(fake, 'gh'), GH); chmodSync(join(fake, 'gh'), 0o755);
  for (const [k, lines] of Object.entries(seq)) writeFileSync(join(fake, `${k}.seq`), lines.join('\n') + '\n');
  for (const [k, body] of Object.entries(wakes)) writeFileSync(join(fake, `wake-${k}.sh`), body);
  const wt = join(home, 'wt', N);
  const run = (args = []) => spawnSync('bash', [join(home, 'rt-work.sh'), N, ...args], {
    encoding: 'utf8', timeout: 120_000,
    env: { ...process.env, RT_XCHECK_MODEL: 'stub-xcheck', ...env, RT_HOME: home, RT_REPO_DIR: repo, RT_GH_REAL: join(fake, 'gh'), FAKE: fake, FAKE_WT: wt, WT: wt,
      FAKE_BRIDGE_LOG: join(fake, 'bridge.log'), RT_WAIT_SLEEP: '1' },
  });
  const bridge = () => (existsSync(join(fake, 'bridge.log')) ? readFileSync(join(fake, 'bridge.log'), 'utf8') : '');
  const status = () => readFileSync(join(home, 'status.tsv'), 'utf8').split('\n').find((l) => l.startsWith(`${N}\t`)) ?? '';
  const issue = () => JSON.parse(readFileSync(join(home, 'state', 'issues', `${N}.json`), 'utf8'));
  const ledger = () => (existsSync(join(home, 'state', 'internal-retries.log')) ? readFileSync(join(home, 'state', 'internal-retries.log'), 'utf8') : '');
  const wlog = () => (existsSync(join(home, "logs", "workers.log")) ? readFileSync(join(home, "logs", "workers.log"), "utf8") : "");
  const merges = () => (existsSync(join(fake, 'merge.n')) ? Number(readFileSync(join(fake, 'merge.n'), 'utf8')) : 0);
  return { home, wt, run, bridge, status, issue, ledger, merges, wlog };
}

test('AC1: the #598 sequence (sync conflict, Gate 0 fail, fix, unpushed fix, done) reaches merge with no rt:blocked', (t) => {
  const s = setup(t, {
    seq: { sync: ['conflict', 'uptodate'], g0: ['fail', 'pass'], merge: ['0'] },
    wakes: {
      3: 'cd "$WT" && echo fix >>README.md && git add README.md && git -c user.name=t -c user.email=t@t commit -qm fix\n' +
         'mkdir -p "$WT/.roundtable/state"; printf "done\\nsummary\\n" >"$WT/.roundtable/state/DECISION"\n',
      4: 'git -C "$WT" push -q origin HEAD:rt/647-pi\nmkdir -p "$WT/.roundtable/state"; printf "done\\nsummary\\n" >"$WT/.roundtable/state/DECISION"\n',
    },
  });
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.merges(), 1, s.wlog());
  assert.match(s.status(), /PR #5 merged/);
  assert.doesNotMatch(s.bridge(), /rt:blocked|Blocked/);
});

test('AC2: a fourth gate-pipeline entry within one wake is queued with a backoff and one ledger line, with no owner comment', (t) => {
  // The counter is reset at the start of every Chief wake, so a gate-only run (no wake) starts from the seeded depth.
  const s = setup(t, { seq: { g0: ['pass'], merge: ['0'] }, env: { GATE_PIPE_DEPTH: '3' } });
  const before = Date.now();
  const r = s.run(['--gate-only']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(s.status(), /\tqueued\t/);
  const due = s.issue().next_retry;
  assert.ok(due >= before / 1000 + 15 * 60 - 5 && due <= Date.now() / 1000 + 15 * 60 + 5, `next_retry ${due}`);
  assert.equal(s.ledger().trim().split('\n').length, 1);
  assert.doesNotMatch(s.bridge(), /comment|rt:blocked/);
  assert.equal(s.merges(), 0);
});

test('AC4: rt-merge rc=9 is a transient hold (PR stays ready, no rt:blocked); the next sweep run merges it', (t) => {
  const s = setup(t, { seq: { sync: ['uptodate'], g0: ['pass'], merge: ['9', '0'] } });
  const first = s.run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(s.status(), /\tdone\t.*ready-to-merge, not auto-merged \(rt-merge-9\)/);
  assert.equal(s.issue().merge_hold, 'transient:rt-merge-9');
  assert.doesNotMatch(s.bridge(), /rt:blocked|Blocked/);
  const second = s.run(['--gate-only']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(s.status(), /PR #5 merged/);
  assert.equal(s.merges(), 2);
});
