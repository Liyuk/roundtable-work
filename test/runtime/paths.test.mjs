import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
