import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCurrentRelease, ReleaseError } from '../../runtime/lib/release.mjs';

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'rt-release-'));
  assert.ok(base.startsWith(tmpdir()));
  const rtd = join(base, 'rtd');
  await mkdir(join(rtd, 'releases'), { recursive: true });
  return { rtd, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const rejectsRelease = (promise, message) => assert.rejects(promise, (err) => {
  assert.ok(err instanceof ReleaseError);
  assert.equal(err.code, 'RT_RELEASE_FAILED');
  assert.match(err.message, /no work started/);
  assert.match(err.message, message);
  return true;
});

test('a valid current symlink resolves to its release sha', async () => {
  const { rtd, cleanup } = await setup();
  try {
    await mkdir(join(rtd, 'releases', 'abc1234'));
    await symlink(join(rtd, 'releases', 'abc1234'), join(rtd, 'current'));
    const got = await resolveCurrentRelease(rtd);
    assert.equal(got.sha, 'abc1234');
    assert.equal(got.path, join(rtd, 'releases', 'abc1234'));
  } finally { await cleanup(); }
});

test('a dangling current symlink is rejected', async () => {
  const { rtd, cleanup } = await setup();
  try {
    await symlink(join(rtd, 'releases', 'abc1234'), join(rtd, 'current'));
    await rejectsRelease(resolveCurrentRelease(rtd), /dangling or unknown release/);
  } finally { await cleanup(); }
});

test('current naming an unknown sha is rejected', async () => {
  const { rtd, cleanup } = await setup();
  try {
    await symlink(join(rtd, 'releases', 'deadbeef'), join(rtd, 'current'));
    await rejectsRelease(resolveCurrentRelease(rtd), /dangling or unknown release/);
  } finally { await cleanup(); }
});

test('current pointing outside the releases dir is rejected', async () => {
  const { rtd, cleanup } = await setup();
  try {
    const outside = join(rtd, '..', 'outside', 'abc1234');
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(rtd, 'current'));
    await rejectsRelease(resolveCurrentRelease(rtd), /points outside releases/);
  } finally { await cleanup(); }
});

test('a missing current is rejected', async () => {
  const { rtd, cleanup } = await setup();
  try {
    await rejectsRelease(resolveCurrentRelease(rtd), /missing or not a symlink/);
  } finally { await cleanup(); }
});

test('a malformed sha directory name is rejected', async () => {
  const { rtd, cleanup } = await setup();
  try {
    await mkdir(join(rtd, 'releases', 'NOT-A-SHA'));
    await symlink(join(rtd, 'releases', 'NOT-A-SHA'), join(rtd, 'current'));
    await rejectsRelease(resolveCurrentRelease(rtd), /points outside releases/);
  } finally { await cleanup(); }
});

test('an empty base dir is a TypeError', async () => {
  await assert.rejects(resolveCurrentRelease(''), TypeError);
});
