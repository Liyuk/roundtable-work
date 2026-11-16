import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPrRecord, upsertPrRecord } from '../../runtime/lib/pr-record.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RTD = join(ROOT, 'runtime/rtd.mjs');
const ROUTING = fileURLToPath(new URL('./routing-fixture.json', import.meta.url));
// Runtime lock records live in a private anchor, never in the work root.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-cutover-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const ADMISSIBLE = '## Goal\nFixture task.\n\n## Acceptance criteria\nRun: `node --test test/runtime/cutover.test.mjs`; Expected: exit 0.\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 10\nFiles: 1';
const RATIONALE = 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.';
const PASS = '审查结论：通过';
const SHA = 'a'.repeat(40);
const BODY = upsertPrRecord('', buildPrRecord({ issue: '21', head: SHA, tree: 'tree1', passed: ['gate0', 'gate1', 'gate2', 'ci'] }));
const READS = ['repo view', 'issue list', 'issue view', 'pr list', 'pr view'];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rt-cutover-'));
  const repo = join(root, 'repo'), workRoot = join(root, 'work'), bin = join(root, 'bin');
  await mkdir(repo); await mkdir(workRoot); await mkdir(bin);
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-b', 'main'); await writeFile(join(repo, 'file'), 'fixture'); git('add', 'file');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  return { root, repo, workRoot, bin, ghLog: join(root, 'gh.log'), providerLog: join(root, 'providers.log') };
}

// Fake gh: answers the reads with one admissible, unclaimed issue; accepts writes; records every invocation.
async function fakeGh({ bin, ghLog }) {
  const issue = { id: '21', number: 21, state: 'OPEN', author: { login: 'owner' }, title: '[A] cutover', body: ADMISSIBLE, createdAt: '2020-01-01', labels: [{ name: 'type:feature' }], comments: [] };
  const answers = { 'repo view': { owner: { login: 'owner' } }, 'issue list': [issue], 'issue view': { comments: [], state: 'OPEN', labels: [] }, 'pr list': [], 'pr view': { body: BODY }, 'pr edit': '', 'issue edit': '', 'issue comment': '' };
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + '\\n');
const answers = ${JSON.stringify(answers)};
const key = args.slice(0, 2).join(' ');
if (!(key in answers)) { console.error('unexpected gh call'); process.exit(1); }
console.log(typeof answers[key] === 'string' ? answers[key] : JSON.stringify(answers[key]));
`);
  await chmod(join(bin, 'gh'), 0o755);
}

// Fake providers module: gates and merge are local; every gate call and the squash are logged.
async function fakeProviders({ root, providerLog }) {
  const providers = join(root, 'providers.mjs');
  await writeFile(providers, `import { appendFileSync } from 'node:fs';
const log = (entry) => appendFileSync(${JSON.stringify(providerLog)}, JSON.stringify(entry) + '\\n');
const SHA = ${JSON.stringify(SHA)};
const BODY = ${JSON.stringify(BODY)};
const stub = () => { throw new Error('not reached in the cutover fixture'); };
export default {
  context: { async get() { return { pr: 90, head: SHA, tree: 'tree1', highRisk: true, changedFiles: ['runtime/rtd.mjs'] }; } },
  gates: {
    async gate0() { log('gate0'); return true; },
    async reviewer() { log('gate1'); return { passed: true, head: SHA, rationale: ${JSON.stringify(RATIONALE)} }; },
    async crossCheck() { log('gate2'); return true; },
  },
  github: {
    async setBase() {}, async getPullRequest() { return { state: 'open', draft: false, mergeable: true, head: SHA, body: 'Closes #21 ' + BODY, files: ['runtime/rtd.mjs'], ownerLogin: 'owner', comments: [] }; },
    async requiredGreen() { return true; },
    async squashMerge(pr) { log(['squash', pr]); return { mergeCommit: 'abcdef0123456789' }; },
    async addLabel() {}, async recordedEscalationApproval() { return null; }, async createComment() {},
    async mainStatus() { return { head: 'abcdef0123456789', status: 'green' }; },
    openRevertPullRequest: stub, createIssue: stub,
  },
  git: { createRevert: stub },
  observation: {
    expectedSha() { return SHA; },
    issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
    worktree: { async inspect() { return { dirty: false }; } },
    git: { async head() { return SHA; }, async commit() { return { sha: SHA }; } },
    evidence: { async checks() { return { sha: SHA, conclusion: 'success' }; }, async review() { return { sha: SHA, conclusion: 'approved' }; } },
  },
};
`);
  const handler = join(root, 'handler.mjs');
  await writeFile(handler, `export default async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? ${JSON.stringify(PASS)} : 'ok' });\nexport async function preDispatch() { return { ok: true }; }\n`);
  return { providers, handler };
}

function runRtd(args, bin) {
  const child = spawn(process.execPath, [RTD, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

const readLines = async (path) => (await readFile(path, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const isRead = (args) => READS.includes(args.slice(0, 2).join(' '));

// The one invocation under test; only `--live` (and the decisions file) differ between the two modes.
async function runCycle(f, extra = []) {
  await fakeGh(f);
  const { providers, handler } = await fakeProviders(f);
  return runRtd(['--work-root', f.workRoot, '--github', '--repo', 'owner/repo', '--repo-root', f.repo, '--handler', handler, '--providers', providers, '--routing', ROUTING, ...extra], f.bin);
}

test('shadow run with a live decision equal to the shadow one: only reads reach gh and the cycle diff is empty', async () => {
  const f = await fixture();
  try {
    const decisions = join(f.root, 'live.json');
    await writeFile(decisions, JSON.stringify({ 21: 'done' }));
    const result = await runCycle(f, ['--live-decisions', decisions]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcomes[0].status, 'done');
    const gh = await readLines(f.ghLog);
    assert.deepEqual(gh.filter((args) => !isRead(args)), [], 'shadow makes no gh write');
    assert.equal(await readFile(join(f.workRoot, 'shadow', 'cycle-1.jsonl'), 'utf8'), '');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('shadow run with a live decision that differs: only reads reach gh and the cycle diff has one line', async () => {
  const f = await fixture();
  try {
    const decisions = join(f.root, 'live.json');
    await writeFile(decisions, JSON.stringify({ 21: 'wait' }));
    const result = await runCycle(f, ['--live-decisions', decisions]);
    assert.equal(result.code, 0, result.stderr);
    const gh = await readLines(f.ghLog);
    assert.deepEqual(gh.filter((args) => !isRead(args)), [], 'shadow makes no gh write');
    assert.equal(await readFile(join(f.workRoot, 'shadow', 'cycle-1.jsonl'), 'utf8'), '{"issue":"21","shadow":"done","live":"wait"}\n');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('the same invocation with and without --live differs only in writes', async () => {
  const shadow = await fixture(), live = await fixture();
  try {
    const shadowRun = await runCycle(shadow);
    const liveRun = await runCycle(live, ['--live']);
    assert.equal(shadowRun.code, 0, shadowRun.stderr);
    assert.equal(liveRun.code, 0, liveRun.stderr);
    assert.equal(JSON.parse(shadowRun.stdout).outcomes[0].status, JSON.parse(liveRun.stdout).outcomes[0].status);

    const shadowGh = await readLines(shadow.ghLog), liveGh = await readLines(live.ghLog);
    const sorted = (calls) => calls.map((args) => JSON.stringify(args)).sort();
    assert.deepEqual(sorted(shadowGh.filter(isRead)), sorted(liveGh.filter(isRead)), 'same reads');
    assert.deepEqual(shadowGh.filter((args) => !isRead(args)), []);
    assert.ok(liveGh.some((args) => args[0] === 'issue' && args[1] === 'edit' && args.includes('rt:running')), 'live writes the claim');

    // Gates run in both modes; only the squash differs, and shadow fences it at the GitHub client.
    const shadowProviders = await readLines(shadow.providerLog), liveProviders = await readLines(live.providerLog);
    assert.deepEqual(liveProviders, ['gate0', 'gate1', 'gate2', ['squash', 90]]);
    assert.deepEqual(shadowProviders, ['gate0', 'gate1', 'gate2']);

    // Shadow writes its cycle file; live does not.
    assert.equal(await readFile(join(shadow.workRoot, 'shadow', 'cycle-1.jsonl'), 'utf8'), '{"issue":"21","shadow":"done","live":null}\n');
    await assert.rejects(readFile(join(live.workRoot, 'shadow', 'cycle-1.jsonl'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(shadow.root, { recursive: true, force: true });
    await rm(live.root, { recursive: true, force: true });
  }
});

// Deploy and bin are launch or configuration only. Keep these rules short and explicit.
const WRITE_CALLS = /\bgh\s+(pr\s+(merge|create|close|edit)|issue\s+(create|edit|comment|close))\b|squashMerge|addLabel|removeLabel|createComment|createIssue|closePullRequest|createRevert|openRevertPullRequest/;
const RUNTIME_IMPORT_OWNER = 'bin/rt-chief.mjs'; // the front-chief CLI is the only launcher allowed to import runtime modules

function launchFiles(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true })
    .map((name) => `${dir}/${name}`)
    .filter((rel) => statSync(join(ROOT, rel)).isFile());
}

test('the rtd unit starts runtime/rtd.mjs only, in shadow mode (no --live in the template)', () => {
  const unit = readFileSync(join(ROOT, 'deploy/systemd/rtd.service'), 'utf8');
  const execStart = unit.match(/^ExecStart=(.*)$/m)[1];
  const scripts = execStart.match(/\S+\.(?:mjs|js|sh|py)\b/g) ?? [];
  assert.deepEqual(scripts.map((path) => basename(path)), ['rtd.mjs']);
  assert.match(scripts[0], /runtime\/rtd\.mjs$/);
  assert.doesNotMatch(execStart, /(^|\s)--live(\s|$)/);
  assert.doesNotMatch(execStart, /\b(sh|bash)\b/, 'ExecStart must not run a shell script');
});

test('every file under bin/ and deploy/ is launch or configuration only', () => {
  const files = [...launchFiles('bin'), ...launchFiles('deploy')];
  assert.ok(files.length > 0);
  for (const rel of files) {
    const text = readFileSync(join(ROOT, rel), 'utf8');
    assert.doesNotMatch(rel, /\.(sh|py)$/, `${rel}: no shell or Python scripts`);
    assert.doesNotMatch(text, /^#!.*\b(sh|bash|python3?)\b/m, `${rel}: no shell or Python shebang`);
    assert.doesNotMatch(text, WRITE_CALLS, `${rel}: no GitHub write call`);
    const runtimeImports = [...text.matchAll(/(?:from|import\()\s*'([^']+)'/g)].map((m) => m[1]).filter((spec) => spec.includes('runtime/'));
    if (rel !== RUNTIME_IMPORT_OWNER) assert.deepEqual(runtimeImports, [], `${rel}: only ${RUNTIME_IMPORT_OWNER} may import runtime modules`);
  }
});
