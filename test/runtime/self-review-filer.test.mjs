import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSelfReviewTimer, runSelfJob, SELF_REVIEW_TIMER } from '../../runtime/lib/self-review-filer.mjs';
import { openTimers } from '../../runtime/lib/event-timers.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';
import { admission } from '../../runtime/lib/intake.mjs';
import { scanHygiene } from '../../runtime/lib/hygiene.mjs';

// Seams: ensureSelfReviewTimer, the inbox event the timer fires, and runSelfJob (proposals + filer, or a promotion).
// Tracker is a fake client; clocks are injected; no network and no gh.
const DAY = 86_400_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const fpOf = (rule, key) => createHash('sha256').update(`${rule}:${key}`).digest('hex').slice(0, 12);
const marker = (fp) => `<!-- rt:fingerprint ${fp} -->`;
const goals = {
  metrics: { windowDays: 7, mtbiHoursMin: 24, firstPassRateMin: 0.8, ownerPullInsPerWeekMax: 3 },
  selfReview: { cadenceHours: 24, maxPerDay: 3, maxOpen: 5, hostPatchMaxAgeDays: 3, failureRepeat: { count: 3, days: 7 } },
};
const emptyMetrics = { mtbiHours: [], firstPassRate: [], ownerPullInsPerWeek: [] };
const inventory = (...tags) => tags.map((tag) => `| ${tag} | desc | not ported: no runtime counterpart |`).join('\n');
const inputs = (extra = {}) => ({ metrics: emptyMetrics, failures: [], cases: [], interventions: [], inventory: '', ...extra });
const goodSpec = { goal: 'Port the inventory row.', acceptance: [{ run: 'npm test', expected: 'exit 0' }], outOfScope: 'Other rows.', touchSet: ['runtime/lib/x.mjs'], lines: 120, files: 1 };
const big = async () => JSON.stringify({ ...goodSpec, lines: 300 });

function fakeClient({ open = [], closed = [], failAfterCreate = false } = {}) {
  const issues = [...open];
  const labelsCreated = [];
  const find = (n) => issues.find((i) => i.number === n);
  let next = 100;
  return {
    issues, labelsCreated,
    listOpen: async () => issues.filter((i) => i.state === 'OPEN'),
    listClosed: async () => closed,
    search: async (query) => issues.filter((i) => i.body.includes(query)),
    getIssue: async (n) => find(n),
    createLabel: async (name) => { labelsCreated.push(name); },
    createIssue: async (title, body) => {
      const number = next++;
      issues.push({ number, title, body, labels: [], state: 'OPEN' });
      if (failAfterCreate) throw new Error('connection reset after create');
      return { number };
    },
    addLabel: async (n, label) => { find(n).labels.push(label); },
    removeLabel: async (n, label) => { find(n).labels = find(n).labels.filter((l) => l !== label); },
  };
}

// A workspace root plus a denylist kept outside it (hygiene refuses an in-repository denylist).
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'rt-self-filer-'));
  const outside = await mkdtemp(join(tmpdir(), 'rt-self-filer-deny-'));
  const denylistPath = join(outside, 'names.json');
  await writeFile(denylistPath, '[]');
  const hygiene = { denylistPath, repoRoot: root, expectedSha256: createHash('sha256').update('[]').digest('hex') };
  return { root, hygiene, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]) };
}

// The timer path: register, fire at `now`, then hand the self-review inbox event to the job.
async function fireDaily(root, { now = NOW, client, completer, hygiene, extra = {} }) {
  const timers = openTimers(root);
  ensureSelfReviewTimer(timers, goals, NOW);
  timers.fire(now);
  const event = openInbox(root).events().filter((e) => e.payload?.job === 'self-review').at(-1);
  return runSelfJob({ root, now, event, goals, inputs: inputs(extra), client, completer, hygiene });
}

const records = async (root) => (await readFile(join(root, '.roundtable/state/self-review.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('the daily timer is registered once and its inbox event runs proposals and the filer', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    ensureSelfReviewTimer(openTimers(root), goals, NOW);
    ensureSelfReviewTimer(openTimers(root), goals, NOW + DAY);
    const timers = openTimers(root).list().filter((t) => t.id === SELF_REVIEW_TIMER);
    assert.equal(timers.length, 1);
    assert.deepEqual([timers[0].kind, timers[0].cadenceMs], ['recurring', DAY]);
    const client = fakeClient();
    const results = await fireDaily(root, { client, hygiene, extra: { inventory: inventory('tag-a') } });
    assert.deepEqual(results.map((r) => r.outcome), ['filed']);
    assert.deepEqual(client.issues.map((i) => i.title), ['Inventory row not ported: tag-a']);
  } finally { await cleanup(); }
});

test('at most maxPerDay issues per UTC day (earlier filings today count) and at most maxOpen open source:self issues', async () => {
  const daily = await workspace();
  try {
    const client = fakeClient();
    const results = await fireDaily(daily.root, { client, hygiene: daily.hygiene, extra: { inventory: inventory('t1', 't2', 't3', 't4', 't5') } });
    assert.deepEqual(results.map((r) => r.outcome), ['filed', 'filed', 'filed', 'deferred', 'deferred']);
    assert.deepEqual(results.slice(3).map((r) => r.reason), ['daily-cap', 'daily-cap']);
    assert.equal(client.issues.length, 3);
    assert.equal((await records(daily.root)).filter((r) => r.outcome === 'deferred').length, 2);
  } finally { await daily.cleanup(); }

  const second = await workspace();
  try {
    // Two filings today already, one yesterday: only one of the two candidates may be filed.
    const log = [{ at: iso(NOW - 2 * DAY), outcome: 'filed' }, { at: iso(NOW - 1000), outcome: 'filed' }, { at: iso(NOW - 2000), outcome: 'filed' }];
    await mkdir(join(second.root, '.roundtable/state'), { recursive: true });
    await writeFile(join(second.root, '.roundtable/state/self-review.jsonl'), log.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const client = fakeClient();
    const results = await fireDaily(second.root, { client, hygiene: second.hygiene, extra: { inventory: inventory('d1', 'd2') } });
    assert.deepEqual(results.map((r) => [r.outcome, r.reason]), [['filed', undefined], ['deferred', 'daily-cap']]);
  } finally { await second.cleanup(); }

  const open = await workspace();
  try {
    const existing = Array.from({ length: 4 }, (_, i) => ({ number: i + 1, title: `Open ${i}`, body: 'x', labels: ['source:self'], state: 'OPEN' }));
    const client = fakeClient({ open: existing });
    const results = await fireDaily(open.root, { client, hygiene: open.hygiene, extra: { inventory: inventory('u1', 'u2') } });
    assert.deepEqual(results.map((r) => [r.outcome, r.reason]), [['filed', undefined], ['deferred', 'open-cap']]);
  } finally { await open.cleanup(); }
});

test('a candidate is skipped for an open issue or an issue closed in the last 30 days carrying its fingerprint', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient({
      open: [{ number: 1, title: 'open', body: `x ${marker(fpOf('T5', 'a'))}`, labels: [], state: 'OPEN' }],
      closed: [
        { number: 2, title: 'closed recently', body: marker(fpOf('T5', 'b')), state: 'CLOSED', closedAt: iso(NOW - 10 * DAY) },
        { number: 3, title: 'closed long ago', body: marker(fpOf('T5', 'c')), state: 'CLOSED', closedAt: iso(NOW - 40 * DAY) },
      ],
    });
    const results = await fireDaily(root, { client, hygiene, extra: { inventory: inventory('a', 'b', 'c') } });
    assert.deepEqual(results.map((r) => [r.outcome, r.reason]), [['skipped', 'fingerprint'], ['skipped', 'fingerprint'], ['filed', undefined]]);
  } finally { await cleanup(); }
});

test('a candidate is skipped when overlappingIssues reports a closed issue from the last 14 days', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const acceptance = '## Acceptance criteria\nthe inventory row names a tracking issue or a regression test';
    const client = fakeClient({ closed: [{ number: 4, title: 'Inventory row not ported: tag-d', body: acceptance, state: 'CLOSED', closedAt: iso(NOW - 2 * DAY) }] });
    const results = await fireDaily(root, { client, hygiene, extra: { inventory: inventory('tag-d') } });
    assert.deepEqual(results.map((r) => [r.outcome, r.reason]), [['skipped', 'overlap']]);
    assert.equal(client.issues.length, 0);
  } finally { await cleanup(); }
});

test('the body comes from the completer, or a deterministic evidence body when its JSON is invalid; both are admitted and hygiene-clean', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient();
    const completer = async (c) => (c.title.endsWith('tag-a') ? JSON.stringify(goodSpec) : '{"goal":');
    await fireDaily(root, { client, hygiene, completer, extra: { inventory: inventory('tag-a', 'tag-b') } });
    const [model, fallback] = client.issues;
    assert.match(model.body, /Port the inventory row\./);
    assert.match(fallback.body, /npm test && npm run check/);
    assert.match(fallback.body, /^- Evidence: tag-b$/m);
    for (const [issue, tag] of [[model, 'tag-a'], [fallback, 'tag-b']]) {
      assert.ok(admission({ title: issue.title, body: issue.body }).admitted, tag);
      assert.deepEqual(await scanHygiene({ entries: [{ value: issue.title }, { value: issue.body }], ...hygiene }), [], tag);
      assert.ok(issue.body.includes(marker(fpOf('T5', tag))), tag);
    }
  } finally { await cleanup(); }
});

test('a create that throws after succeeding does not produce a second issue on retry', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient({ failAfterCreate: true });
    const first = await fireDaily(root, { client, hygiene, extra: { inventory: inventory('tag-x') } });
    assert.deepEqual(first.map((r) => r.outcome), ['filed']);
    client.createIssue = async () => { throw new Error('create must not run again'); };
    const second = await fireDaily(root, { now: NOW + 1000, client, hygiene, extra: { inventory: inventory('tag-x') } });
    assert.deepEqual(second.map((r) => r.reason), ['fingerprint']);
    assert.equal(client.issues.length, 1);
  } finally { await cleanup(); }
});

test('low-risk candidates get rt:go; others get rt:hold and a once self-promote timer', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient();
    await fireDaily(root, { client, hygiene, completer: async () => JSON.stringify(goodSpec), extra: { inventory: inventory('go-row') } });
    assert.deepEqual(client.issues[0].labels, ['source:self', 'type:feature', 'priority:p2', 'rt:go']);
    assert.ok(client.labelsCreated.includes('source:self'));
  } finally { await cleanup(); }

  const safety = await workspace();
  try {
    const client = fakeClient();
    const touchGoals = async () => JSON.stringify({ ...goodSpec, touchSet: ['runtime/goals.json'] });
    await fireDaily(safety.root, { client, hygiene: safety.hygiene, completer: touchGoals, extra: { inventory: inventory('safe-row') } });
    assert.deepEqual(client.issues[0].labels, ['source:self', 'type:feature', 'priority:p2', 'rt:hold']);
  } finally { await safety.cleanup(); }

  const long = await workspace();
  try {
    const client = fakeClient();
    await fireDaily(long.root, { client, hygiene: long.hygiene, completer: big, extra: { inventory: inventory('long-row') } });
    assert.deepEqual(client.issues[0].labels, ['source:self', 'type:feature', 'priority:p2', 'rt:hold']);
    assert.equal(openTimers(long.root).list().find((t) => t.id === `self-promote:${client.issues[0].number}`).kind, 'once');
  } finally { await long.cleanup(); }
});

test('the self-promote timer adds rt:go after 24 h unless the issue was closed or labelled rt:owner', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient();
    await fireDaily(root, { client, hygiene, completer: big, extra: { inventory: inventory('p1') } });
    const promoteAt = NOW + DAY;
    const promote = (number) => {
      openTimers(root).fire(promoteAt);
      const event = openInbox(root).events().find((e) => e.payload.job === 'self-promote' && e.payload.number === number);
      return runSelfJob({ root, now: promoteAt, event, goals, client });
    };
    client.issues[0].labels.push('rt:owner');
    assert.equal(await promote(client.issues[0].number), 'skipped');
    assert.ok(!client.issues[0].labels.includes('rt:go'));
  } finally { await cleanup(); }

  const closed = await workspace();
  try {
    const client = fakeClient();
    await fireDaily(closed.root, { client, hygiene: closed.hygiene, completer: big, extra: { inventory: inventory('p2') } });
    client.issues[0].state = 'CLOSED';
    openTimers(closed.root).fire(NOW + DAY);
    const event = openInbox(closed.root).events().find((e) => e.payload.job === 'self-promote');
    assert.equal(await runSelfJob({ root: closed.root, now: NOW + DAY, event, goals, client }), 'skipped');
    assert.ok(!client.issues[0].labels.includes('rt:go'));
  } finally { await closed.cleanup(); }

  const open = await workspace();
  try {
    const client = fakeClient();
    await fireDaily(open.root, { client, hygiene: open.hygiene, completer: big, extra: { inventory: inventory('p3') } });
    openTimers(open.root).fire(NOW + DAY);
    const event = openInbox(open.root).events().find((e) => e.payload.job === 'self-promote');
    assert.equal(await runSelfJob({ root: open.root, now: NOW + DAY, event, goals, client }), 'promoted');
    assert.deepEqual(client.issues[0].labels, ['source:self', 'type:feature', 'priority:p2', 'rt:go']);
  } finally { await open.cleanup(); }
});

test('each filed issue appends one self ledger entry with category backlog', async () => {
  const { root, hygiene, cleanup } = await workspace();
  try {
    const client = fakeClient();
    await fireDaily(root, { client, hygiene, extra: { inventory: inventory('ledger-row') } });
    const entries = openInterventions(root).entries().entries;
    assert.deepEqual(entries.map((e) => [e.category, e.source, e.ref]), [['backlog', 'self', `#${client.issues[0].number}`]]);
  } finally { await cleanup(); }
});
