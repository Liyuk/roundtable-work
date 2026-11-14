import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, readlink, rm, lstat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCurrentRelease } from '../../runtime/lib/release.mjs';

const script = fileURLToPath(new URL('../../scripts/release.mjs', import.meta.url));

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'rt-release-install-'));
  const repo = join(root, 'repo');
  const home = join(root, 'home');
  const base = join(root, 'rtd');
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(home);
  await writeFile(join(repo, 'README.md'), 'hello\n');
  await writeFile(join(repo, 'src', 'index.mjs'), 'export const x = 1;\n');
  const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  const sha = git('rev-parse', 'HEAD').stdout.trim();
  const run = (...args) => spawnSync(process.execPath, [script, '--base', base, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, XDG_DATA_HOME: '' },
  });
  return { root, repo, base, sha, run, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function snapshot(dir) {
  const out = [];
  const walk = async (rel) => {
    const abs = join(dir, rel);
    const st = await lstat(abs);
    if (st.isDirectory()) {
      out.push(`${rel}/`);
      for (const name of (await readdir(abs)).sort()) await walk(join(rel, name));
    } else if (st.isSymbolicLink()) {
      out.push(`${rel} -> ${await readlink(abs)}`);
    } else {
      out.push(`${rel} ${createHash('sha256').update(await readFile(abs)).digest('hex')}`);
    }
  };
  await walk('.');
  return out;
}

test('dry-run writes nothing and does not create the base dir', async () => {
  const { root, repo, base, run, cleanup } = await setup();
  try {
    const before = await snapshot(root);
    const res = run();
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(await snapshot(root), before);
    await assert.rejects(lstat(base), { code: 'ENOENT' });
    assert.match(res.stdout, /--apply/);
  } finally { await cleanup(); }
});

test('apply exports the commit tree into releases/<sha>', async () => {
  const { repo, base, sha, run, cleanup } = await setup();
  try {
    const res = run('--apply');
    assert.equal(res.status, 0, res.stderr);
    const expected = spawnSync('git', ['ls-tree', '-r', '--name-only', sha], { cwd: repo, encoding: 'utf8' })
      .stdout.trim().split('\n').sort();
    const actual = (await snapshot(join(base, 'releases', sha)))
      .filter((line) => !line.endsWith('/')).map((line) => line.split(' ')[0]).sort();
    assert.deepEqual(actual, expected);
    assert.equal(await readFile(join(base, 'releases', sha, 'src', 'index.mjs'), 'utf8'), 'export const x = 1;\n');
  } finally { await cleanup(); }
});

test('apply --point-current makes current resolve to the full sha', async () => {
  const { base, sha, run, cleanup } = await setup();
  try {
    const res = run('--apply', '--point-current');
    assert.equal(res.status, 0, res.stderr);
    const got = await resolveCurrentRelease(base);
    assert.equal(got.sha, sha);
  } finally { await cleanup(); }
});

test('refuses to replace a current that is a regular file', async () => {
  const { base, run, cleanup } = await setup();
  try {
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'current'), 'not a link\n');
    const before = await snapshot(base);
    const res = run('--apply', '--point-current');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /not a symlink/);
    assert.deepEqual(await snapshot(base), before);
  } finally { await cleanup(); }
});
