import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runQueue, clearMainPause, EXIT_LOCKED, EXIT_LOCK_LOST } from '../../runtime/rtd.mjs';
import { createProductionAdapter } from '../../runtime/lib/production.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { acquireLock } from '../../runtime/lib/lock.mjs';

const tmp = () => mkdtemp(join(process.cwd(), 'rt119-'));
// Lock records live in the private anchor, never in the work root: keep the host's real anchor untouched.
const ANCHOR = mkdtempSync(join(tmpdir(), 'rt119-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* leaving /tmp behind is harmless */ } });
const exists = (path) => access(path).then(() => true, () => false);
const PASSOUT = '审查结论：通过';
const OBSERVED_SHA = 'a'.repeat(40);
const handler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASSOUT : 'ok' });
const RTD = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));

// Default production providers: PR 90 is the merge candidate, PR 91 the revert pull request.
function providers(overrides = {}) {
  const github = {
    async getPullRequest(pr) { return { state: 'open', draft: false, mergeable: true, head: pr === 90 ? 'head' : 'reverthead', files: ['x'] }; },
    async requiredGreen() { return true; },
    async squashMerge(pr) { return { mergeCommit: pr === 90 ? 'abcdef0123456789' : '1111111111111111' }; },
    async addLabel() {},
    async recordedEscalationApproval() {},
    async mainStatus() { return { head: 'abcdef0123456789', status: 'green' }; },
    async openRevertPullRequest() { return { number: 91, head: 'reverthead' }; },
    async createIssue() { return { number: 92 }; },
    ...overrides.github,
  };
  return createProductionAdapter({
    github,
    git: { async createRevert() { return { sha: '1234567' }; }, ...overrides.git },
    context: { async get({ recovery } = {}) {
      return recovery
        ? { pr: 91, head: 'reverthead', tree: 'reverttree', highRisk: false, changedFiles: ['x'] }
        : { pr: 90, head: 'head', tree: 'tree', highRisk: false, changedFiles: ['x'] };
    }, ...overrides.context },
    gates: { async gate0() { return true; }, async reviewer({ head }) { return { passed: true, head }; }, async crossCheck() { return true; }, ...overrides.gates },
    observation: {
      expectedSha: ({ expectedSha }) => expectedSha ?? OBSERVED_SHA,
      issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
      worktree: { async inspect() { return { dirty: false }; } },
      git: { async head() { return OBSERVED_SHA; }, async commit() { return { sha: OBSERVED_SHA }; } },
      evidence: { async checks() { return { sha: OBSERVED_SHA, conclusion: 'success' }; }, async review() { return { sha: OBSERVED_SHA, conclusion: 'approved' }; } },
    },
    ...(overrides.pause ? { pause: overrides.pause } : {}),
  });
}

/** Seed a monitor record as a crashed earlier pass would have written it. */
async function seedMarker(root, value) {
  const store = await createStateStore({ workRoot: root });
  await store.update('rt-main-monitor', (s) => { s.mainMonitor = value; });
  return store;
}

const marker = (extra = {}) => ({ stage: 'merging', pr: 90, head: 'head', tree: 'tree', since: 1_000_000, ...extra });

/** Policy: issues must never echo provider error text, host paths, or URLs. */
const assertNoHostDetail = (text, label) => {
  assert.doesNotMatch(text, /provider is down/, `${label} must not echo the provider error`);
  assert.doesNotMatch(text, /https?:\/\//, `${label} must not echo a URL`);
  assert.doesNotMatch(text, /(^|[\s("'`])\/(?:[\w.~-]+\/)+/m, `${label} must not echo an absolute path`);
};

test('a transient squash failure is resolved from the still-open pull request on the next pass', async () => {
  const root = await tmp();
  const calls = [];
  let failOnce = true;
  const autoMerge = providers({
    github: {
      async squashMerge(pr) {
        calls.push(['squash', pr]);
        if (failOnce) { failOnce = false; throw new Error('transient squash failure'); }
        return { mergeCommit: 'abcdef0123456789' };
      },
    },
  });
  try {
    const crashed = await runQueue({ workRoot: root, queue: ['53'], handler, autoMerge });
    assert.equal(crashed.outcomes[0].status, 'interrupted');
    assert.equal(crashed.outcomes[0].decision, 'ask');
    const store = await createStateStore({ workRoot: root });
    const record = (await store.load('rt-main-monitor')).mainMonitor;
    assert.equal(record.stage, 'merging');
    assert.equal(record.pr, 90);
    assert.equal(record.head, 'head');
    assert.equal(record.tree, 'tree');
    assert.equal(typeof record.since, 'number');

    const resumed = await runQueue({ workRoot: root, queue: ['54'], handler, autoMerge });
    assert.deepEqual(resumed.skipped, [], 'the open pull request clears the hold instead of pausing the pass');
    assert.equal(resumed.outcomes[0].status, 'done');
    assert.deepEqual(calls.map((c) => c[1]), [90, 90], 'the next pass retries the resolved merge');
    assert.equal((await store.load('rt-main-monitor')).mainMonitor, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a pre-seeded crash marker for a closed, unmerged pull request clears the hold and admits work', async () => {
  const root = await tmp();
  let pulls = 0;
  const autoMerge = providers({ github: { async getPullRequest() { pulls++; return { state: 'closed', draft: false, mergeable: false, head: 'head', files: ['x'] }; } } });
  try {
    const store = await seedMarker(root, marker());
    const result = await runQueue({ workRoot: root, queue: ['54'], handler, autoMerge });
    assert.deepEqual(result.skipped, [], 'a closed unmerged pull request clears the hold instead of pausing the pass');
    assert.ok(pulls >= 1, 'the marker was resolved from the live pull request');
    assert.notEqual(result.outcomes[0]?.status, 'main_paused');
    assert.equal((await store.load('rt-main-monitor')).mainMonitor, null, 'the record is cleared, never re-seeded');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a pre-seeded crash marker for an open pull request clears the hold and admits work', async () => {
  const root = await tmp();
  const seen = [];
  const autoMerge = providers({ github: { async getPullRequest(pr) { seen.push(pr); return { state: 'open', draft: false, mergeable: true, head: pr === 90 ? 'head' : 'reverthead', files: ['x'] }; } } });
  try {
    const store = await seedMarker(root, marker());
    const result = await runQueue({ workRoot: root, queue: ['54'], handler, autoMerge });
    assert.deepEqual(result.skipped, []);
    assert.equal(result.outcomes[0].status, 'done');
    assert.ok(seen.includes(90), 'the marker was resolved from the live pull request');
    assert.equal((await store.load('rt-main-monitor')).mainMonitor, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unrecognized or malformed pull request state retains the hold and admits no work', async () => {
  for (const live of [{ state: 'unknown' }, { state: '' }, { state: null }, {}]) {
    const root = await tmp();
    let ran = false;
    let squashes = 0;
    const autoMerge = providers({ github: {
      async getPullRequest() { return live; },
      async squashMerge() { squashes++; return { mergeCommit: 'abcdef0123456789' }; },
    } });
    try {
      const store = await seedMarker(root, marker());
      const result = await runQueue({ workRoot: root, queue: ['54'], handler: async () => { ran = true; return { exitCode: 0, output: 'ok' }; }, autoMerge, now: () => 1_000_000 });
      assert.deepEqual(result.outcomes, [], JSON.stringify(live));
      assert.deepEqual(result.skipped, [{ id: '54', reason: 'main_paused' }], JSON.stringify(live));
      assert.equal((await store.load('rt-main-monitor')).mainMonitor.stage, 'merging');
      assert.equal(ran, false);
      assert.equal(squashes, 0);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('merged true resolves a marker even when the state is not recognized', async () => {
  const root = await tmp();
  const autoMerge = providers({ github: { async getPullRequest() { return { state: 'unknown', merged: true, mergeCommit: 'abcdef0123456789' }; } } });
  try {
    const store = await seedMarker(root, marker());
    await runQueue({ workRoot: root, queue: [], handler, autoMerge });
    assert.equal((await store.load('rt-main-monitor')).mainMonitor, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a merged marker with a merge commit moves to monitoring and still reverts a red main', async () => {
  const root = await tmp();
  const calls = [];
  let main = { head: 'abcdef0123456789', status: 'red' };
  const autoMerge = providers({
    github: {
      async getPullRequest(pr) {
        const merged = pr === 90;
        return { state: merged ? 'merged' : 'open', draft: false, mergeable: true, head: merged ? 'head' : 'reverthead', files: ['x'], ...(merged ? { mergeCommit: 'abcdef0123456789' } : {}) };
      },
      async mainStatus() { return main; },
      async openRevertPullRequest() { calls.push('revert-pr'); return { number: 91, head: 'reverthead' }; },
      async createIssue(arg) { calls.push(['issue', ...arg.labels]); return { number: 92 }; },
      async squashMerge(pr) { calls.push(['squash', pr]); return { mergeCommit: '1111111111111111' }; },
    },
  });
  try {
    const store = await seedMarker(root, marker());
    const first = await runQueue({ workRoot: root, queue: [], handler, autoMerge });
    assert.equal(first.status, 'ok');
    const record = (await store.load('rt-main-monitor')).mainMonitor;
    assert.equal(record.stage, 'monitoring');
    assert.equal(record.mergeCommit, 'abcdef0123456789');
    assert.equal(record.recovery.revertMerged.done, true, 'the existing red-main revert path still runs');
    assert.deepEqual(calls.filter(Array.isArray), [['issue', 'type:bug', 'rt:self'], ['squash', 91]]);
    assert.equal(calls.filter((c) => c === 'revert-pr').length, 1);

    main = { head: '2222222222222222', status: 'green' };
    const second = await runQueue({ workRoot: root, queue: [], handler, autoMerge });
    assert.equal(second.status, 'ok');
    assert.equal((await store.load('rt-main-monitor')).mainMonitor, null, 'green main after the revert releases the hold');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a merged marker without a merge commit and a green main clears the hold', async () => {
  const root = await tmp();
  let issues = 0;
  let merged = true;
  const autoMerge = providers({
    github: {
      async getPullRequest(pr) {
        return merged
          ? { state: 'merged', draft: false, mergeable: true, head: 'head', files: ['x'] }
          : { state: 'open', draft: false, mergeable: true, head: 'head', files: ['x'] };
      },
      async mainStatus() { return { head: 'ffffffffffffffff', status: 'green' }; },
      async createIssue() { issues++; return { number: 92 }; },
    },
  });
  try {
    const store = await seedMarker(root, marker());
    const resolved = await runQueue({ workRoot: root, queue: [], handler, autoMerge });
    assert.equal(resolved.status, 'ok');
    assert.equal((await store.load('rt-main-monitor')).mainMonitor, null);
    assert.equal(issues, 0);

    merged = false;
    const next = await runQueue({ workRoot: root, queue: ['54'], handler, autoMerge });
    assert.deepEqual(next.skipped, []);
    assert.equal(next.outcomes[0].status, 'done', 'work resumes once the hold is gone');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a merged marker without a merge commit and a red main escalates exactly once and stays paused', async () => {
  const root = await tmp();
  const issues = [];
  let inFlightBeforeEffect = null;
  const reader = await createStateStore({ workRoot: root });
  const autoMerge = providers({
    github: {
      async getPullRequest() { return { state: 'merged', draft: false, mergeable: true, head: 'head', files: ['x'] }; },
      async mainStatus() { return { head: 'eeeeeeeeeeeeeeee', status: 'red' }; },
      async createIssue(arg) {
        const escalation = (await reader.load('rt-main-monitor')).mainMonitor?.escalation;
        inFlightBeforeEffect = escalation?.inFlight === true && escalation?.done !== true;
        issues.push(arg);
        return { number: 92 };
      },
    },
  });
  try {
    const store = await seedMarker(root, marker());
    const first = await runQueue({ workRoot: root, queue: [], handler, autoMerge });
    assert.equal(first.status, 'ok');
    assert.equal(issues.length, 1);
    assert.equal(inFlightBeforeEffect, true, 'the escalation marker is durable before the createIssue effect');
    assert.deepEqual(issues[0].labels, ['type:bug', 'rt:self']);
    assert.match(issues[0].title, /#90/);
    assert.match(issues[0].body, /#90/);
    assert.match(issues[0].body, /--clear-main-pause/);

    let ran = false;
    const second = await runQueue({ workRoot: root, queue: ['54'], handler: async () => { ran = true; return { exitCode: 0, output: 'ok' }; }, autoMerge });
    assert.equal(second.skipped[0].reason, 'main_paused');
    assert.equal(ran, false);
    assert.equal(issues.length, 1, 'no duplicate issue on a later pass');
    const record = (await store.load('rt-main-monitor')).mainMonitor;
    assert.equal(record.stage, 'merging');
    assert.equal(record.escalation.done, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an unreadable pull request keeps the hold, then escalates once after the timeout', async () => {
  const root = await tmp();
  const clock = { t: 1_000_000 };
  const issues = [];
  let attempts = 0;
  const autoMerge = providers({
    github: {
      async getPullRequest() { attempts++; throw new Error(`provider is down: /srv/roundtable/config.json https://github.example.test/status`); },
      async createIssue(arg) { issues.push(arg); return { number: 92 }; },
    },
  });
  const pass = () => runQueue({ workRoot: root, queue: ['54'], handler, autoMerge, now: () => clock.t, mergeUnknownTimeoutMs: 60_000 });
  try {
    const store = await seedMarker(root, marker({ since: clock.t }));
    const first = await pass();
    assert.equal(first.skipped[0].reason, 'main_paused');
    assert.equal(issues.length, 0);
    assert.equal((await store.load('rt-main-monitor')).mainMonitor.attempts, 1);

    clock.t += 60_001;
    const second = await pass();
    assert.equal(second.skipped[0].reason, 'main_paused');
    assert.equal(issues.length, 1, 'the aged unknown outcome is reported');
    assertNoHostDetail(issues[0].title, 'the issue title');
    assertNoHostDetail(issues[0].body, 'the issue body');
    assert.equal((await store.load('rt-main-monitor')).mainMonitor.escalation.done, true);
    assert.match((await store.load('rt-main-monitor')).mainMonitor.lastError, /provider is down/, 'the durable marker keeps the diagnostic');

    clock.t += 60_000;
    const third = await pass();
    assert.equal(third.skipped[0].reason, 'main_paused');
    assert.equal(issues.length, 1, 'a repeated pass creates no duplicate issue');
    assert.equal(attempts, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a legacy marker without a pull request number is escalated, never ignored', async () => {
  const root = await tmp();
  let pulls = 0;
  let issues = 0;
  const autoMerge = providers({
    github: {
      async getPullRequest() { pulls++; return { state: 'open', draft: false, mergeable: true, head: 'head', files: ['x'] }; },
      async createIssue() { issues++; return { number: 92 }; },
    },
  });
  try {
    await seedMarker(root, { stage: 'merging' });
    const result = await runQueue({ workRoot: root, queue: ['54'], handler, autoMerge });
    assert.equal(result.skipped[0].reason, 'main_paused');
    assert.equal(pulls, 0, 'there is no pull request to resolve');
    assert.equal(issues, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--clear-main-pause is a no-op success when nothing is set', async () => {
  const root = await tmp();
  const providersPath = join(root, 'providers.mjs');
  await writeFile(providersPath, 'export default {};\n');
  try {
    const child = spawnSync(process.execPath, [RTD, '--work-root', root, '--providers', providersPath, '--clear-main-pause'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { status: 'ok', cleared: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--clear-main-pause clears the persisted record and the pause backend', async () => {
  const root = await tmp();
  const pauseFile = join(root, 'pause.json');
  const providersPath = join(root, 'providers.mjs');
  await writeFile(providersPath, `
import { readFile, rm, writeFile } from 'node:fs/promises';
const file = ${JSON.stringify(pauseFile)};
export default {
  pause: {
    async get() { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } },
    async put(value) { if (value === null) await rm(file, { force: true }); else await writeFile(file, JSON.stringify(value)); },
  },
};
`);
  try {
    const store = await seedMarker(root, marker());
    await writeFile(pauseFile, JSON.stringify(marker()));
    const child = spawnSync(process.execPath, [RTD, '--work-root', root, '--providers', providersPath, '--clear-main-pause'], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { status: 'ok', cleared: true });
    assert.equal((await store.load('rt-main-monitor')).mainMonitor, null);
    assert.equal(await exists(pauseFile), false, 'the injected pause backend is cleared too');
    // The runtime agrees the hold is gone.
    const result = await runQueue({ workRoot: root, queue: ['54'], handler, autoMerge: providers() });
    assert.deepEqual(result.skipped, []);
    assert.equal(result.outcomes[0].status, 'done');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('--clear-main-pause exits 75 when another pass holds the lock and clears nothing', async () => {
  const root = await tmp();
  const providersPath = join(root, 'providers.mjs');
  await writeFile(providersPath, 'export default {};\n');
  const store = await seedMarker(root, marker());
  const holder = await acquireLock({ lockPath: join(root, '.roundtable', 'state', 'rtd.lock.d'), repoRoot: root, owner: 'other' });
  assert.equal(holder.acquired, true);
  try {
    const child = spawnSync(process.execPath, [RTD, '--work-root', root, '--providers', providersPath, '--clear-main-pause'], { encoding: 'utf8' });
    assert.equal(child.status, EXIT_LOCKED, child.stderr);
    assert.notEqual(child.status, EXIT_LOCK_LOST);
    assert.equal(JSON.parse(child.stdout).status, 'locked');
    assert.equal((await store.load('rt-main-monitor')).mainMonitor.pr, 90);
  } finally {
    await holder.release();
    await rm(root, { recursive: true, force: true });
  }
});

test('clearMainPause validates the pause provider and the lock lease option', async () => {
  await assert.rejects(clearMainPause({ workRoot: join(process.cwd(), 'rt119-unused'), providers: { pause: {} } }), /provider pause\.get and pause\.put are required/);
  await assert.rejects(clearMainPause({ workRoot: join(process.cwd(), 'rt119-unused'), lockTtlMs: 0 }), /lockTtlMs must be a positive number/);
});
