import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createConfinement, assertSafeId, PathEscapeError } from '../../runtime/lib/paths.mjs';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'rt-paths-'));
  const root = join(base, 'root');
  const outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
  return { root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
}

test('paths inside the root resolve, including ones that do not exist yet', async () => {
  const { root, cleanup } = await setup();
  try {
    const c = await createConfinement(root);
    assert.equal(await c.resolve('state', 'a.json'), join(root, 'state', 'a.json'));
    assert.equal(await c.resolve('a/b/../c'), join(root, 'a', 'c'));
  } finally { await cleanup(); }
});

test('withParent anchors paths through the portable file descriptor namespace', async () => {
  const { root, cleanup } = await setup();
  try {
    const c = await createConfinement(root);
    const contents = await c.withParent('state/nested.json', async (dir, name) => {
      assert.match(dir, /^\/dev\/fd\//);
      assert.doesNotMatch(dir, /\/proc(?:\/|$)/);
      await mkdir(dir + '/state', { recursive: true });
      await writeFile(`${dir}/${name}`, 'portable');
      return fs.readFile(`${dir}/${name}`, 'utf8');
    }, { create: true });
    assert.equal(contents, 'portable');
  } finally { await cleanup(); }
});

test('withParent promptly rejects creation beneath a deleted pinned parent', async () => {
  const base = await mkdtemp(join(process.cwd(), '.rt-paths-'));
  const root = join(base, 'root');
  try {
    await mkdir(root);
    const script = `
      import assert from 'node:assert/strict';
      import { mkdir, rm } from 'node:fs/promises';
      import { createConfinement } from './runtime/lib/paths.mjs';
      const root = process.argv[1];
      const c = await createConfinement(root);
      await assert.rejects(c.withParent('state/file', () => {
        throw new Error('callback must not run');
      }, { create: true, fs: { mkdir: async (...args) => {
        await rm(root, { recursive: true });
        return mkdir(...args);
      } } }), { code: 'ENOENT' });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL',
    });
    assert.equal(child.error?.code, undefined, `child failed or timed out: ${child.error}`);
    assert.equal(child.status, 0, child.stderr);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('retries when an entry is created between realpath and lstat', async (t) => {
  const { root, cleanup } = await setup();
  try {
    const c = await createConfinement(root);
    const created = join(root, 'state');
    const originalRealpath = fs.realpath;
    let injected = false;
    t.mock.method(fs, 'realpath', async (...args) => {
      if (args[0] === created && !injected) {
        injected = true;
        await mkdir(created);
        throw Object.assign(new Error('Entry was missing'), { code: 'ENOENT' });
      }
      return originalRealpath(...args);
    });
    syncBuiltinESMExports();
    assert.equal(await c.resolve('state', 'a.json'), join(created, 'a.json'));
    assert.equal(injected, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await cleanup();
  }
});

test('fails closed when an existing entry repeatedly cannot be resolved', async (t) => {
  const { root, cleanup } = await setup();
  try {
    const entry = join(root, 'unstable');
    await mkdir(entry);
    const c = await createConfinement(root);
    const originalRealpath = fs.realpath;
    t.mock.method(fs, 'realpath', async (...args) => {
      if (args[0] === entry) throw Object.assign(new Error('Entry was missing'), { code: 'ENOENT' });
      return originalRealpath(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(c.resolve('unstable'), { name: 'PathEscapeError', message: /Unable to resolve unstable path/ });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await cleanup();
  }
});

test('.. escapes and absolute paths outside the root are rejected', async () => {
  const { root, outside, cleanup } = await setup();
  try {
    const c = await createConfinement(root);
    for (const bad of [['..'], ['../outside'], ['a/../../outside/x'], [outside], ['state', '..', '..', 'x']]) {
      await assert.rejects(c.resolve(...bad), PathEscapeError, bad.join('/'));
    }
    await assert.rejects(c.resolve(''), PathEscapeError);
    await assert.rejects(c.resolve('a\0b'), PathEscapeError);
  } finally { await cleanup(); }
});

test('symlink escapes are rejected: directory link, file link, dangling link, and a missing tail below a link', async () => {
  const { root, outside, cleanup } = await setup();
  try {
    await writeFile(join(outside, 'secret'), 'x');
    await symlink(outside, join(root, 'dirlink'));
    await symlink(join(outside, 'secret'), join(root, 'filelink'));
    await symlink(join(outside, 'missing'), join(root, 'dangling'));
    const c = await createConfinement(root);
    for (const bad of ['dirlink', 'dirlink/secret', 'dirlink/new/deep.json', 'filelink', 'dangling']) {
      await assert.rejects(c.resolve(bad), PathEscapeError, bad);
    }
  } finally { await cleanup(); }
});

test('a symlink that stays inside the root is allowed', async () => {
  const { root, cleanup } = await setup();
  try {
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'alias'));
    const c = await createConfinement(root);
    assert.equal(await c.resolve('alias', 'f'), join(root, 'alias', 'f'));
  } finally { await cleanup(); }
});

test('ids must be conservative file names', () => {
  assert.equal(assertSafeId(49), '49');
  assert.equal(assertSafeId('rt-1a_x.2'), 'rt-1a_x.2');
  for (const bad of ['', '../x', 'a/b', '.x', 'a..b', 'a b', 'x'.repeat(65)]) assert.throws(() => assertSafeId(bad), PathEscapeError, bad);
});

test('the work root must be a non-empty string that exists', async () => {
  await assert.rejects(createConfinement(''), TypeError);
  await assert.rejects(createConfinement(join(tmpdir(), 'rt-does-not-exist-xyz')), { code: 'ENOENT' });
});
