import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, rmSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RTD = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
const ROUTING = fileURLToPath(new URL('./routing-fixture.json', import.meta.url));
// Runtime lock records live in a private anchor, never in the work root.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-live-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const ADMISSIBLE = '## Goal\nFixture task.\n\n## Acceptance criteria\nRun: `node --test test/runtime/live.test.mjs`; Expected: exit 0.\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 10\nFiles: 1';
const RATIONALE = 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.';
const PASS = '审查结论：通过';
const SHA = 'a'.repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rt-live-'));
  const repo = join(root, 'repo'), workRoot = join(root, 'work'), bin = join(root, 'bin');
  await mkdir(repo); await mkdir(workRoot); await mkdir(bin);
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-b', 'main'); await writeFile(join(repo, 'file'), 'fixture'); git('add', 'file');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  return { root, repo, workRoot, bin, ghLog: join(root, 'gh.log'), providerLog: join(root, 'providers.log') };
}

// Fake gh: answers the reads with one admissible, unclaimed issue; accepts writes; records every invocation.
async function fakeGh({ bin, ghLog }) {
  const issue = { id: '21', number: 21, state: 'OPEN', author: { login: 'owner' }, title: '[A] live', body: ADMISSIBLE, createdAt: '2020-01-01', labels: [{ name: 'type:feature' }], comments: [] };
  const answers = { 'repo view': { owner: { login: 'owner' } }, 'issue list': [issue], 'issue view': { comments: [], state: 'OPEN', labels: [] }, 'pr list': [], 'issue edit': '', 'issue comment': '' };
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

// Fake providers module: every gate, merge and observation answer is local; each gate and merge call is logged.
async function fakeProviders({ root, providerLog }) {
  const providers = join(root, 'providers.mjs');
  await writeFile(providers, `import { appendFileSync } from 'node:fs';
const log = (entry) => appendFileSync(${JSON.stringify(providerLog)}, JSON.stringify(entry) + '\\n');
const SHA = ${JSON.stringify(SHA)};
const stub = () => { throw new Error('not reached in the live fixture'); };
export default {
  context: { async get() { return { pr: 90, head: SHA, tree: 'tree1', highRisk: true, changedFiles: ['runtime/rtd.mjs'] }; } },
  gates: {
    async gate0() { log('gate0'); return true; },
    async reviewer() { log('gate1'); return { passed: true, head: SHA, rationale: ${JSON.stringify(RATIONALE)} }; },
    async crossCheck() { log('gate2'); return true; },
  },
  github: {
    async getPullRequest() { return { state: 'open', draft: false, mergeable: true, head: SHA, files: ['runtime/rtd.mjs'], ownerLogin: 'owner', comments: [] }; },
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
  await writeFile(handler, `export default async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? ${JSON.stringify(PASS)} : 'ok' });\n`);
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

test('with --live the fixture issue is claimed, gated and squash-merged end to end through the fake providers', async () => {
  const f = await fixture();
  try {
    await fakeGh(f);
    const { providers, handler } = await fakeProviders(f);
    const result = await runRtd(['--work-root', f.workRoot, '--github', '--live', '--repo', 'owner/repo', '--repo-root', f.repo, '--handler', handler, '--providers', providers, '--routing', ROUTING], f.bin);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcomes[0].status, 'done');

    const gh = await readLines(f.ghLog);
    assert.ok(gh.some((args) => args[0] === 'issue' && args[1] === 'edit' && args.includes('--add-label') && args.includes('rt:running')), 'claim label written');
    assert.ok(gh.some((args) => args[0] === 'issue' && args[1] === 'comment'), 'claim comment written');

    const providerCalls = await readLines(f.providerLog);
    assert.deepEqual(providerCalls, ['gate0', 'gate1', 'gate2', ['squash', 90]]);
    await assert.rejects(readFile(join(f.workRoot, 'shadow', 'cycle-1.jsonl'), 'utf8'), { code: 'ENOENT' }, 'live mode writes no shadow cycle');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('--live requires --github: the flag alone is a usage error', async () => {
  const f = await fixture();
  try {
    const result = await runRtd(['--work-root', f.workRoot, '--live', '--queue', 'x.json', '--handler', 'h.mjs', '--routing', ROUTING], f.bin);
    assert.equal(result.code, 2, result.stderr);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
