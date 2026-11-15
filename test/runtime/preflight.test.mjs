// Pre-dispatch preflight (ticket 84): convention files, baseline, card key numbers, then environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { runPreDispatch } from '../../runtime/lib/preflight.mjs';
import { runQueue } from './observation-fixture.mjs';

const KEYS = { phases: 4, tests: 12 };
const source = { keyNumbers: KEYS };
const card = (over = {}) => ({ conventions: ['CLAUDE.md'], baseline: '0.2.1', keyNumbers: { ...KEYS }, ...over });
const okExec = async () => ({ exitCode: 0, stderr: '' });

async function worktree(files = ['CLAUDE.md']) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-preflight-wt-'));
  for (const f of files) await writeFile(join(dir, f), '# convention\n');
  return dir;
}
const run = (wt, over = {}) => runPreDispatch({
  card: card(over.card), worktree: wt, source, baseline: { expected: '0.2.1' }, exec: okExec, tmpDir: tmpdir(), ...over.opts,
});

test('a missing convention file is rejected and a present one is accepted', async () => {
  const wt = await worktree([]);
  try {
    assert.equal((await run(wt)).reason, 'missing_convention_file:CLAUDE.md');
    await writeFile(join(wt, 'CLAUDE.md'), 'x');
    assert.deepEqual(await run(wt), { ok: true });
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('a convention path that escapes the worktree is rejected', async () => {
  const wt = await worktree();
  const outside = await worktree(['SECRET.md']);
  try {
    assert.match((await run(wt, { card: { conventions: [join('..', basename(outside), 'SECRET.md')] } })).reason, /^convention_outside_worktree/);
    assert.match((await run(wt, { card: { conventions: [join(outside, 'SECRET.md')] } })).reason, /^convention_outside_worktree/);
    await symlink(join(outside, 'SECRET.md'), join(wt, 'LINK.md'));
    assert.match((await run(wt, { card: { conventions: ['LINK.md'] } })).reason, /^convention_outside_worktree/);
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('a stale or unparseable baseline is rejected and a matching one is accepted', async () => {
  const wt = await worktree();
  try {
    assert.equal((await run(wt, { card: { baseline: '0.2.0' } })).reason, 'baseline_stale');
    assert.equal((await run(wt, { card: { baseline: 'v0.2.1' } })).reason, 'baseline_invalid');
    assert.equal((await run(wt, { card: { baseline: undefined } })).reason, 'baseline_invalid');
    assert.deepEqual(await run(wt, { card: { baseline: '0.2.1' } }), { ok: true });
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('card key numbers must match the source exactly with no unknown keys', async () => {
  const wt = await worktree();
  try {
    assert.equal((await run(wt, { card: { keyNumbers: { phases: 4, tests: 11 } } })).reason, 'numbers_mismatch');
    assert.equal((await run(wt, { card: { keyNumbers: { phases: 4 } } })).reason, 'numbers_mismatch');
    assert.equal((await run(wt, { card: { keyNumbers: { phases: 4, tests: 12, extra: 1 } } })).reason, 'numbers_mismatch');
    assert.deepEqual(await run(wt), { ok: true });
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('checks stop at the first failure, so the environment is not prepared for cheap-check failures', async () => {
  const wt = await worktree([]);
  const calls = [];
  const exec = async (cmd) => { calls.push(cmd); return { exitCode: 0, stderr: '' }; };
  try {
    assert.equal((await run(wt, { opts: { exec } })).reason, 'missing_convention_file:CLAUDE.md');
    await writeFile(join(wt, 'CLAUDE.md'), 'x');
    assert.equal((await run(wt, { card: { baseline: '9.9.9' }, opts: { exec } })).reason, 'baseline_stale');
    assert.equal((await run(wt, { card: { keyNumbers: {} }, opts: { exec } })).reason, 'numbers_mismatch');
    assert.deepEqual(calls, []);
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('a failing prepare command fails closed with a bounded stderr tail', async () => {
  const wt = await worktree();
  const exec = async () => ({ exitCode: 1, stderr: 'e'.repeat(5000) + 'ENOTFOUND registry' });
  try {
    const result = await run(wt, { opts: { exec, prepare: 'npm ci' } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'environment_not_ready');
    assert.ok(result.detail.endsWith('ENOTFOUND registry'));
    assert.ok(result.detail.length <= 2000);
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('an unwritable temp directory fails closed as environment_not_ready', async () => {
  const wt = await worktree();
  const base = await mkdtemp(join(tmpdir(), 'rt-preflight-tmp-'));
  const file = join(base, 'not-a-dir');
  await writeFile(file, 'x');
  try {
    const result = await run(wt, { opts: { tmpDir: file } });
    assert.equal(result.reason, 'environment_not_ready');
    assert.equal(typeof result.detail, 'string');
  } finally {
    await rm(wt, { recursive: true, force: true });
    await rm(base, { recursive: true, force: true });
  }
});

test('the prepare command runs in the worktree and a clean environment passes', async () => {
  const wt = await worktree();
  const seen = [];
  const exec = async (cmd, opts) => { seen.push([cmd, opts.cwd]); return { exitCode: 0, stderr: '' }; };
  try {
    assert.deepEqual(await run(wt, { opts: { exec } }), { ok: true });
    assert.deepEqual(seen, [['npm ci', wt]]);
  } finally { await rm(wt, { recursive: true, force: true }); }
});

test('the developing phase does not start the handler when preDispatch fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-preflight-rtd-'));
  const phases = [];
  try {
    const result = await runQueue({
      workRoot: root, queue: ['84'],
      preDispatch: async () => ({ ok: false, reason: 'baseline_stale' }),
      handler: async ({ phase }) => { phases.push(phase); return { exitCode: 0, output: 'ok' }; },
    });
    assert.deepEqual(phases, []);
    assert.deepEqual([result.outcomes[0].status, result.outcomes[0].class, result.outcomes[0].reason, result.outcomes[0].decision], ['stop', 'predispatch_failed', 'baseline_stale', 'stop']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
