import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSelfReview, gatherInputs } from '../../runtime/lib/self-review-filer.mjs';

// Seams: gatherInputs (bench.jsonl, last two rows) and fileSelfReview with an injected fake client. No gh, no network.
const NOW = Date.parse('2026-11-15T12:00:00Z');
const goals = {
  metrics: { windowDays: 7, mtbiHoursMin: 24, firstPassRateMin: 0.8, ownerPullInsPerWeekMax: 3 },
  selfReview: { cadenceHours: 24, maxPerDay: 3, maxOpen: 5, hostPatchMaxAgeDays: 3, failureRepeat: { count: 3, days: 7 } },
};
const marker = (fp) => `<!-- rt:fingerprint ${fp} -->`;
const benchLine = (body) => body.split('\n').filter((line) => line.startsWith('Bench: '));
const dims = (U) => ({ U, L: 5, I: 5, D: 5, overall: U });
const snap = (at, u3, u) => ({ at, ids: { U3: { value: u3[0], level: u3[1], measurable: u3[2] } }, dimensions: dims(u) });
const PREV = snap('2026-11-14T00:00:00.000Z', [21, 5, true], 5);
const LATEST = snap('2026-11-15T00:00:00.000Z', [0, 2, true], 4);

async function workspace(rows) {
  const root = await mkdtemp(join(tmpdir(), 'rt-self-bench-'));
  const outside = await mkdtemp(join(tmpdir(), 'rt-self-bench-deny-'));
  await mkdir(join(root, '.roundtable/state'), { recursive: true });
  await writeFile(join(root, '.roundtable/state/bench.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  await writeFile(join(outside, 'names.json'), '[]');
  const hygiene = { denylistPath: join(outside, 'names.json'), repoRoot: root, expectedSha256: createHash('sha256').update('[]').digest('hex') };
  return { root, hygiene, cleanup: () => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]) };
}

function fakeClient(open = []) {
  const issues = [...open];
  const comments = [];
  let next = 100;
  return {
    issues, comments,
    listOpen: async () => issues.filter((i) => i.state === 'OPEN'),
    listClosed: async () => [],
    search: async (q) => issues.filter((i) => i.body.includes(q)),
    createLabel: async () => {},
    createIssue: async (title, body) => { issues.push({ number: next, title, body, labels: [], state: 'OPEN' }); return { number: next++ }; },
    addLabel: async (n, label) => { issues.find((i) => i.number === n).labels.push(label); },
    removeLabel: async () => {},
    createComment: async (n, body) => { comments.push({ n, body }); },
  };
}

const run = (root, hygiene, client) => fileSelfReview({ root, now: NOW, goals, inputs: gatherInputs(root), client, hygiene });

test('gatherInputs reads the last two bench.jsonl rows and skips malformed lines', async () => {
  const { root, cleanup } = await workspace([PREV, LATEST]);
  try {
    await writeFile(join(root, '.roundtable/state/bench.jsonl'), `${JSON.stringify(PREV)}\nnot json\n${JSON.stringify(LATEST)}\n`);
    assert.deepEqual(gatherInputs(root).bench.map((r) => r.at), [PREV.at, LATEST.at]);
  } finally { await cleanup(); }
});

test('a sub-metric regression files one bench:<ID> issue with one Bench line, p1 label (its dimension U dropped) and type:bug', async () => {
  const w = await workspace([PREV, LATEST]);
  try {
    const client = fakeClient();
    const results = await run(w.root, w.hygiene, client);
    assert.deepEqual(results.map((r) => [r.outcome, r.fingerprint]), [['filed', 'bench:U3']]);
    const [issue] = client.issues;
    assert.ok(issue.body.includes(marker('bench:U3')));
    assert.deepEqual(benchLine(issue.body), ['Bench: U3 0 -> 21 (level 2 -> 5) within 7 d']);
    assert.ok(issue.labels.includes('type:bug') && issue.labels.includes('priority:p1'));
  } finally { await w.cleanup(); }
});

test('an open issue with the marker is updated by one comment on every run, never a second issue', async () => {
  const w = await workspace([PREV, LATEST]);
  try {
    const existing = { number: 7, title: 'Bench regression: U3', body: `x\n${marker('bench:U3')}`, labels: [], state: 'OPEN' };
    const client = fakeClient([existing]);
    const first = await run(w.root, w.hygiene, client);
    const second = await run(w.root, w.hygiene, client);
    assert.deepEqual([first, second].map((rs) => rs.map((r) => [r.outcome, r.number])), [[['updated', 7]], [['updated', 7]]]);
    assert.equal(client.issues.length, 1);
    assert.equal(client.comments.length, 2);
    assert.equal(client.comments[0].n, 7);
    assert.deepEqual(benchLine(client.comments[0].body), ['Bench: U3 0 -> 21 (level 2 -> 5) within 7 d']);
    assert.equal(existing.body, `x\n${marker('bench:U3')}`);
  } finally { await w.cleanup(); }
});

test('a dimension drop without a sub-metric regression files bench:U with p1 and the dimension score', async () => {
  const w = await workspace([snap('2026-11-14T00:00:00.000Z', [0, 5, true], 5), snap('2026-11-15T00:00:00.000Z', [0, 5, true], 3)]);
  try {
    const client = fakeClient();
    const results = await run(w.root, w.hygiene, client);
    assert.deepEqual(results.map((r) => [r.outcome, r.fingerprint]), [['filed', 'bench:U'], ['filed', 'bench:overall']]);
    assert.deepEqual(benchLine(client.issues[0].body), ['Bench: U 3 -> 5 (level 3 -> 5) within 7 d']);
    assert.ok(client.issues[0].labels.includes('priority:p1'));
  } finally { await w.cleanup(); }
});
