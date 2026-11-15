import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { parseTouchSet, overlaps, lockKeysOf } from '../../runtime/lib/touch-set.mjs';
import { runWorkers } from '../../runtime/lib/workers.mjs';
import { acquireLock, lockDirectoryFor } from '../../runtime/lib/lock.mjs';

// Issue and touch locks live in the private anchor (RTW_STATE_DIR), inherited by the child process below.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });
const scratch = join(process.cwd(), '.roundtable/scratch/310-dev-1/tmp');
const temp = async () => { await mkdir(scratch, { recursive: true }); return mkdtemp(join(scratch, 'touch-')); };
const section = (...lines) => ['## Goal', 'x', '## Touch set', ...lines].join('\n');

test('parseTouchSet returns the normalized bullet paths and stops at the next heading', () => {
  const body = ['## Touch set', '- runtime/lib/queue.mjs', '-  docs/guide.md ', '', '## Acceptance', '- not a touch path'].join('\n');
  assert.deepEqual(parseTouchSet(body), ['runtime/lib/queue.mjs', 'docs/guide.md']);
});

test('parseTouchSet returns null when the section is missing', () => {
  assert.equal(parseTouchSet('## Goal\nNo touch set here.'), null);
  assert.equal(parseTouchSet(''), null);
});

test('parseTouchSet returns null for an empty, non-bullet, absolute, or traversing section', () => {
  assert.equal(parseTouchSet(section('')), null);
  assert.equal(parseTouchSet(section('runtime/lib/queue.mjs', 'some prose')), null);
  assert.equal(parseTouchSet(section('/etc/passwd')), null);
  assert.equal(parseTouchSet(section('- ../escape.mjs')), null);
  assert.equal(parseTouchSet(section('- runtime/../../escape.mjs')), null);
});

test('overlap is equality or segment-aware directory prefix', () => {
  assert.equal(overlaps('runtime/lib/queue.mjs', 'runtime/lib/queue.mjs'), true);
  assert.equal(overlaps('runtime/lib', 'runtime/lib/queue.mjs'), true);
  assert.equal(overlaps('runtime/lib/queue.mjs', 'runtime/lib'), true);
  assert.equal(overlaps('runtime/lib', 'runtime/libx'), false);
  assert.equal(overlaps('runtime/lib/a.mjs', 'runtime/lib/b.mjs'), false);
});

test('lock keys are the path plus every ancestor directory, sorted and unique', () => {
  assert.deepEqual(lockKeysOf(['runtime/lib/queue.mjs', 'runtime/lib']), ['runtime', 'runtime/lib', 'runtime/lib/queue.mjs']);
});

test('overlapping shared doc serializes like code while disjoint top-level files run in parallel', async () => {
  const root = await temp();
  const peakOf = async (issues) => {
    let active = 0, peak = 0;
    await runWorkers({ issues, workRoot: root, workers: 2, run: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
    } });
    return peak;
  };
  try {
    const doc = (id) => ({ id, title: `doc ${id}`, body: section(`- docs/guide.md`) });
    assert.equal(await peakOf([doc('1'), doc('2')]), 1);
    const disjoint = (id) => ({ id, title: `code ${id}`, body: section(`- fixture-${id}.txt`) });
    assert.equal(await peakOf([disjoint('1'), disjoint('2')]), 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an issue with a missing or unparseable touch set runs serially with every other issue', async () => {
  const root = await temp();
  try {
    let active = 0, peak = 0;
    const run = async () => { active++; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 20)); active--; };
    await runWorkers({ issues: [{ id: '1', title: '[A] one', body: section('- fixture-1.txt') }, { id: '2', title: '[B] two', body: '## Goal\nnone' }], workRoot: root, workers: 2, run });
    assert.equal(peak, 1);
    peak = 0;
    await runWorkers({ issues: [{ id: '3', title: '[C] three', body: section('- fixture-3.txt') }, { id: '4', title: '[D] four', body: section('- fixture-4.txt', 'prose line') }], workRoot: root, workers: 2, run });
    assert.equal(peak, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a second worker in another process cannot claim an overlapping touch set while the first holds it', async () => {
  const root = await temp();
  try {
    const repo = join(root, 'repo'), workRoot = join(root, 'work');
    await mkdir(repo); await mkdir(workRoot);
    let started; const begun = new Promise((resolve) => { started = resolve; });
    let release; const gate = new Promise((resolve) => { release = resolve; });
    const first = runWorkers({ issues: [{ id: 'a', title: '[A] holder', body: section('- runtime/lib/queue.mjs') }], workRoot, repoRoot: repo, workers: 1,
      run: async () => { started(); await gate; } });
    await begun;
    const workersUrl = new URL('../../runtime/lib/workers.mjs', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `const { runWorkers } = await import(${JSON.stringify(workersUrl)});
      const r = await runWorkers({ issues: [{ id: 'b', title: '[B] challenger', body: '## Touch set\\n- runtime/lib' }], workRoot: ${JSON.stringify(workRoot)}, repoRoot: ${JSON.stringify(repo)}, run: async () => { console.log('RAN'); } });
      console.log(JSON.stringify(r.skipped));`], { encoding: 'utf8' });
    release();
    await first;
    assert.equal(child.status, 0, child.stderr);
    assert.doesNotMatch(child.stdout, /RAN/);
    const skipped = JSON.parse(child.stdout.trim());
    assert.equal(skipped.length, 1);
    assert.deepEqual([skipped[0].id, skipped[0].reason], ['b', 'touch_set_locked']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('disjoint siblings under a shared ancestor directory are never skipped in one run', async () => {
  const root = await temp();
  try {
    const completedRuns = [];
    const sibling = (id, file) => ({ id, title: `code ${id}`, body: section(`- runtime/lib/${file}`) });
    const result = await runWorkers({ issues: [sibling('1', 'a.mjs'), sibling('2', 'b.mjs')], workRoot: root, workers: 2, run: async (issue) => { completedRuns.push(issue.id); } });
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(result.failed, []);
    assert.deepEqual([...result.completed].sort(), ['1', '2']);
    assert.deepEqual(completedRuns.sort(), ['1', '2']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a touch lock whose refresh fails aborts the run as issue lock loss', async () => {
  const root = await temp();
  const repo = join(root, 'repo'), workRoot = join(root, 'work');
  await mkdir(repo); await mkdir(workRoot);
  try {
    const touchDir = lockDirectoryFor({ lockPath: join(workRoot, 'locks', `touch-${createHash('sha256').update('runtime/lib/a.mjs').digest('hex')}.lock.d`), repoRoot: repo, anchorRoot: ANCHOR });
    let sawAbort = false;
    const result = await runWorkers({ issues: [{ id: '1', title: '[A] touch', body: section('- runtime/lib/a.mjs') }], workRoot, repoRoot: repo, workers: 1, lockTtlMs: 30, run: async (_issue, { signal }) => {
      // Drop the touch lock's epoch record: the next touch refresh cannot find its own record and must report loss.
      for (const name of await readdir(touchDir)) if (name.startsWith('epoch-')) await rm(join(touchDir, name));
      await new Promise((resolve) => setTimeout(resolve, 100));
      sawAbort = signal.aborted;
    } });
    assert.equal(sawAbort, true);
    assert.deepEqual(result.completed, []);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].error.message, 'issue lock lost');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a touch lock stays alive for the whole run so a second acquirer is refused', async () => {
  const root = await temp();
  const repo = join(root, 'repo'), workRoot = join(root, 'work');
  await mkdir(repo); await mkdir(workRoot);
  try {
    const lockPath = join(workRoot, 'locks', `touch-${createHash('sha256').update('runtime/lib/a.mjs').digest('hex')}.lock.d`);
    let intruder;
    const result = await runWorkers({ issues: [{ id: '1', title: '[A] touch', body: section('- runtime/lib/a.mjs') }], workRoot, repoRoot: repo, workers: 1, lockTtlMs: 300, run: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      intruder = await acquireLock({ lockPath, repoRoot: repo, owner: 'intruder' });
    } });
    assert.deepEqual(result.failed, []);
    assert.equal(intruder.acquired, false);
    assert.deepEqual(result.completed, ['1']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
