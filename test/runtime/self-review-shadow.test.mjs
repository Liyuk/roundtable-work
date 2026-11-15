import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSelfReviewClient } from '../../runtime/rtd.mjs';
import { ensureSelfReviewTimer, runSelfJob } from '../../runtime/lib/self-review-filer.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';

// Seams: createSelfReviewClient (the client rtd hands to runSelfJob) driven through runSelfJob, the daily timer path
// (fileSelfReview) and the self-promote timer path (promoteHold). The writer is a counting fake; no network, no gh.
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const WRITES = ['createIssue', 'createLabel', 'addLabel', 'removeLabel'];
const goals = {
  metrics: { windowDays: 7, mtbiHoursMin: 24, firstPassRateMin: 0.8, ownerPullInsPerWeekMax: 3 },
  selfReview: { cadenceHours: 24, maxPerDay: 3, maxOpen: 5, hostPatchMaxAgeDays: 3, failureRepeat: { count: 3, days: 7 } },
};
const emptyInputs = { metrics: { mtbiHours: [], firstPassRate: [], ownerPullInsPerWeek: [] }, failures: [], cases: [], interventions: [], inventory: '' };
const inventory = '| tag-a | desc | not ported: no runtime counterpart |';
const goodSpec = { goal: 'Port the inventory row.', acceptance: [{ run: 'npm test', expected: 'exit 0' }], outOfScope: 'Other rows.', touchSet: ['runtime/lib/x.mjs'], lines: 120, files: 1 };
const hold = { number: 7, title: 'Held issue', body: 'x', state: 'OPEN', labels: [{ name: 'rt:hold' }] };

// Counting fake of the GitHub tracker: every call (reads and writes) is recorded by name.
function countingGitHub() {
  const calls = [];
  const record = (name, fn) => async (...args) => { calls.push(name); return fn(...args); };
  const writer = {
    searchIssues: record('searchIssues', async () => []),
    createIssue: record('createIssue', async () => ({ number: 99 })),
    createLabel: record('createLabel', async () => {}),
    addLabel: record('addLabel', async () => {}),
    removeLabel: record('removeLabel', async () => {}),
  };
  const reader = {
    listIssues: record('listIssues', async () => []),
    listClosedIssues: record('listClosedIssues', async () => []),
    getIssue: record('getIssue', async () => hold),
  };
  return { writer, reader, calls, writes: () => calls.filter((name) => WRITES.includes(name)) };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'rt-self-shadow-'));
  const outside = await mkdtemp(join(tmpdir(), 'rt-self-shadow-deny-'));
  const denylistPath = join(outside, 'names.json');
  await writeFile(denylistPath, '[]');
  const hygiene = { denylistPath, repoRoot: root, expectedSha256: createHash('sha256').update('[]').digest('hex') };
  return { root, hygiene, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]) };
}

test('shadow: the daily self-review files nothing at the writer, while the fenced create/label path is exercised', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const gh = countingGitHub();
    const attempted = [];
    const client = createSelfReviewClient({ reader: gh.reader, writer: gh.writer, shadow: true, attempted });
    ensureSelfReviewTimer(openTimers(root), goals, NOW);
    openTimers(root).fire(NOW);
    const event = openInbox(root).events().filter((e) => e.payload?.job === 'self-review').at(-1);
    const inputs = { ...emptyInputs, inventory };
    const results = await runSelfJob({ root, now: NOW, event, goals, inputs, client, completer: async () => JSON.stringify(goodSpec), hygiene });
    assert.deepEqual(results.map((r) => r.outcome), ['failed']);
    assert.deepEqual(gh.writes(), []);
    assert.deepEqual(attempted, ['createLabel', 'createIssue']);
  } finally { await cleanup(); }
});

test('shadow: the self-promote timer path promotes nothing at the writer', async () => {
  const gh = countingGitHub();
  const attempted = [];
  const client = createSelfReviewClient({ reader: gh.reader, writer: gh.writer, shadow: true, attempted });
  const result = await runSelfJob({ root: '', now: NOW, event: { payload: { job: 'self-promote', number: 7 } }, goals, inputs: emptyInputs, client });
  assert.equal(result, 'promoted');
  assert.deepEqual(gh.writes(), []);
  assert.deepEqual(attempted, ['addLabel', 'removeLabel']);
});

test('live control: without shadow the same client forwards writes to the raw writer', async () => {
  const gh = countingGitHub();
  const client = createSelfReviewClient({ reader: gh.reader, writer: gh.writer, shadow: false });
  const result = await runSelfJob({ root: '', now: NOW, event: { payload: { job: 'self-promote', number: 7 } }, goals, inputs: emptyInputs, client });
  assert.equal(result, 'promoted');
  assert.deepEqual(gh.writes(), ['addLabel', 'removeLabel']);
});
