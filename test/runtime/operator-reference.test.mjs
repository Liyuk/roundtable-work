import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ADMISSIBLE = '## Goal\nReference fixture task.\n\n## Acceptance criteria\nRun: `node --test test/runtime/operator-reference.test.mjs`; Expected: exit 0.\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 10\nFiles: 1';
// Runtime lock records live in a private anchor, never in the work root.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-operator-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const exists = (path) => access(path).then(() => true, () => false);

test('the reference operator modules run two shadow cycles against a fake gh that only performs reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-operator-'));
  const repo = join(root, 'repo');
  const workRoot = join(root, '.roundtable');
  const bin = join(root, 'bin');
  const log = join(root, 'gh.log');
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  try {
    await mkdir(repo); await mkdir(bin);
    git('init', '-b', 'main'); await writeFile(join(repo, 'file'), 'fixture'); git('add', 'file');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');

    // A fake gh that answers the four reads with an admissible, unclaimed issue and records every invocation.
    const issue = { id: '21', number: 21, state: 'OPEN', author: { login: 'owner' }, title: '[A] reference', body: ADMISSIBLE, createdAt: '2020-01-01', labels: [{ name: 'type:feature' }], comments: [] };
    const answers = { 'repo view': { owner: { login: 'owner' } }, 'issue list': [issue], 'issue view': { comments: [], state: 'OPEN', labels: [] }, 'pr list': [] };
    await writeFile(join(bin, 'gh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const answers = ${JSON.stringify(answers)};
const key = args.slice(0, 2).join(' ');
if (!(key in answers)) { console.error('unexpected gh call'); process.exit(1); }
console.log(JSON.stringify(answers[key]));
`);
    await chmod(join(bin, 'gh'), 0o755);

    const child = spawn(process.execPath, ['runtime/rtd.mjs', '--work-root', workRoot, '--github', '--repo', 'owner/repo', '--repo-root', repo,
      '--handler', 'examples/operator/handler.mjs', '--providers', 'examples/operator/providers.mjs', '--routing', 'examples/operator/routing.json',
      '--loop', '--poll-ms', '50'],
    { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    let closed = false;
    const exited = new Promise((resolve) => child.on('close', (code) => { closed = true; resolve(code); }));
    const deadline = Date.now() + 60_000;
    while (!(await exists(join(workRoot, 'shadow', 'cycle-2.jsonl')))) {
      assert.ok(!closed && Date.now() < deadline, `cycle-2 not written\n${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    child.kill('SIGTERM');
    await exited;

    assert.ok(await exists(join(workRoot, 'shadow', 'cycle-1.jsonl')));
    assert.ok(await exists(join(workRoot, 'shadow', 'cycle-2.jsonl')));
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(calls.length > 0);
    assert.deepEqual(calls.filter((args) => !['repo view', 'issue list', 'issue view', 'pr list'].includes(args.slice(0, 2).join(' '))), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
