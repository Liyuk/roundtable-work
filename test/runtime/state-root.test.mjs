import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { acquireLock, anchorRootOf, lockDirectoryFor, readProjectId } from '../../runtime/lib/lock.mjs';

// Two projects on one machine share the same XDG state home (no RTW_STATE_DIR) and differ only by project id.
const setup = async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'rt-state-root-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, xdg: join(base, 'xdg'), env: { XDG_STATE_HOME: join(base, 'xdg') } };
};

const project = async (base, name, projectId) => {
  const dir = join(base, name);
  await mkdir(join(dir, '.roundtable'), { recursive: true });
  await writeFile(join(dir, '.roundtable', 'project.json'), JSON.stringify({ projectId }));
  return dir;
};

test('anchorRootOf derives the root from the project id; RTW_STATE_DIR overrides it', () => {
  const home = '/h';
  const xdgEnv = { XDG_STATE_HOME: '/x' };
  assert.equal(anchorRootOf({ env: {}, home }), resolve('/h/.local/state/roundtable'));
  assert.equal(anchorRootOf({ env: {}, home, projectId: 'alpha' }), resolve('/h/.local/state/roundtable/projects/alpha'));
  assert.equal(anchorRootOf({ env: xdgEnv, projectId: 'alpha' }), resolve('/x/roundtable/projects/alpha'));
  assert.equal(anchorRootOf({ env: { ...xdgEnv, RTW_STATE_DIR: '/s' }, projectId: 'alpha' }), resolve('/s'));
  assert.throws(() => anchorRootOf({ env: {}, home, projectId: '../evil' }), /^Error: Invalid projectId$/);
});

test('readProjectId returns undefined without a project file and the id when present', async (t) => {
  const { base } = await setup(t);
  assert.equal(await readProjectId(join(base, 'none')), undefined);
  assert.equal(await readProjectId(await project(base, 'a', 'alpha')), 'alpha');
});

test('two projects on one machine get distinct anchor roots and do not block each other', async (t) => {
  const { base, env } = await setup(t);
  const repoA = await project(base, 'a', 'alpha');
  const repoB = await project(base, 'b', 'beta');
  // Same lock name in both projects.
  const lockA = join(repoA, 'rtd.lock.d');
  const lockB = join(repoB, 'rtd.lock.d');
  const holdA = await acquireLock({ lockPath: lockA, owner: 'a1', repoRoot: repoA, env });
  assert.equal(holdA.acquired, true);
  assert.equal(holdA.anchorRoot, resolve(env.XDG_STATE_HOME, 'roundtable', 'projects', 'alpha'));
  // Project A's lock is visible to A (contended) but not to B (acquired).
  assert.equal((await acquireLock({ lockPath: lockA, owner: 'a2', repoRoot: repoA, env })).reason, 'held');
  const holdB = await acquireLock({ lockPath: lockB, owner: 'b1', repoRoot: repoB, env });
  assert.equal(holdB.acquired, true);
  assert.notEqual(holdA.lockDirectory, holdB.lockDirectory);
  assert.equal(holdA.lockDirectory, lockDirectoryFor({ lockPath: lockA, repoRoot: repoA, env, projectId: 'alpha' }));
  assert.equal(holdB.lockDirectory, lockDirectoryFor({ lockPath: lockB, repoRoot: repoB, env, projectId: 'beta' }));
  await holdA.release();
  await holdB.release();
});
