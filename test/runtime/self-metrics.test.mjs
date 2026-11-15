import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selfMetrics } from '../../runtime/lib/self-metrics.mjs';
import { collectStatus, formatStatus } from '../../runtime/lib/status.mjs';

// Fixture week: now = 2026-11-15T00:00Z, windowDays = 7, so W = [2026-11-08T00:00Z, 2026-11-15T00:00Z) = 168 h.
const NOW = Date.UTC(2026, 10, 15);
const H = 3_600_000;
const at = (day, hour = 0) => new Date(Date.UTC(2026, 10, day) + hour * H).toISOString();
const freeze = (start, end) => ({ start: Date.UTC(2026, 10, start[0]) + start[1] * H, end: Date.UTC(2026, 10, end[0]) + end[1] * H, class: 'host-freeze' });

const entries = [
  { id: 'e1', at: at(7, 10), category: 'merge', ref: '#1', source: 'owner', internalized: 'no' },
  { id: 'e2', at: at(8, 6), category: 'liveness', ref: '#2', source: 'external', internalized: 'partial' },
  { id: 'e3', at: at(9, 5), category: 'decision', ref: '#3', source: 'owner', internalized: 'yes' },
  { id: 'e4', at: at(10, 8), category: 'owner-only', ref: 'rt:note', source: 'owner', internalized: 'yes' },
  { id: 'e5', at: at(11, 9), category: 'self-repair', ref: '#4', source: 'self', internalized: 'no' },
  { id: 'e6', at: at(12, 3), category: 'self-repair', ref: '#4', source: 'self', internalized: 'yes' },
  { id: 'e7', at: at(13, 10), category: 'self-repair', ref: '#5', source: 'self', internalized: 'no' },
  { id: 'e8', at: at(13, 11), category: 'self-review', ref: '#6', source: 'owner', internalized: 'no' },
  { id: 'e9', at: at(14, 12), category: 'backlog', ref: '#7', source: 'self', internalized: 'no' },
  // Owner pause/resume pairs: one resumed inside W after a freeze overlap, one pause before W, one still open at now.
  { id: 'p1', at: at(7, 12), category: 'owner-only', ref: 'rt:pause', source: 'owner', internalized: 'yes', kind: 'pause' },
  { id: 'r1', at: at(8, 12), category: 'owner-only', ref: 'rt:resume', source: 'owner', internalized: 'yes', kind: 'resume' },
  { id: 'p2', at: at(9, 1), category: 'owner-only', ref: 'rt:pause', source: 'owner', internalized: 'yes', kind: 'pause' },
  { id: 'r2', at: at(9, 4), category: 'owner-only', ref: 'rt:resume', source: 'owner', internalized: 'yes', kind: 'resume' },
  { id: 'p3', at: at(10, 0), category: 'owner-only', ref: 'rt:pause', source: 'owner', internalized: 'yes', kind: 'pause' },
  { id: 'r3', at: at(10, 6), category: 'owner-only', ref: 'rt:resume', source: 'owner', internalized: 'yes', kind: 'resume' },
  { id: 'p4', at: at(12, 12), category: 'owner-only', ref: 'rt:pause', source: 'owner', internalized: 'yes', kind: 'pause' },
  { id: 'r4', at: at(12, 18), category: 'owner-only', ref: 'rt:resume', source: 'owner', internalized: 'yes', kind: 'resume' },
  { id: 'p5', at: at(14, 20), category: 'owner-only', ref: 'rt:pause', source: 'owner', internalized: 'yes', kind: 'pause' },
];
const freezes = [
  { start: Date.UTC(2026, 10, 7, 22), end: Date.UTC(2026, 10, 8, 2), class: 'host-freeze' },
  freeze([9, 0], [9, 2]),
  freeze([9, 1], [9, 3]),
  { start: Date.UTC(2026, 10, 12), end: Date.UTC(2026, 10, 12, 5), class: 'scheduler-stall' },
];

test('fixture week pins F, P, U, I, MTBI, streak, pull-ins, self actions and internalized share', () => {
  const m = selfMetrics({ entries, freezes, now: NOW, windowDays: 7 });
  // Freeze in W: [8 00-02] + [9 00-03] = 5 h. Covered by freeze or pause in W: 12 + 4 + 6 + 6 + 4 = 32 h; P = 32 - 5 = 27 h.
  assert.equal(m.frozenHours, 5);
  assert.equal(m.pausedHours, 27);
  assert.equal(m.unsupervisedHours, 136);
  assert.equal(m.interventions, 3);
  assert.deepEqual(m.mtbi, { value: 136 / 3, bound: null });
  assert.equal(m.streak, 33);
  assert.deepEqual(m.pullIns.owner, { total: 2, byCategory: { decision: 1, 'self-review': 1 } });
  assert.deepEqual(m.pullIns.external, { total: 1, byCategory: { liveness: 1 } });
  assert.deepEqual(m.selfActions, { total: 4, byCategory: { 'self-repair': 3, backlog: 1 } });
  assert.equal(m.internalizedShare, 0.5);
});

test('MTBI is a lower bound when no counted intervention falls in W', () => {
  const quiet = entries.filter((e) => e.source === 'self');
  const m = selfMetrics({ entries: quiet, freezes: [], now: NOW, windowDays: 7 });
  assert.equal(m.interventions, 0);
  assert.deepEqual(m.mtbi, { value: 168, bound: 'lower' });
});

test('streak and internalized share are n/a with a reason when the ledger has no data for them', () => {
  const m = selfMetrics({ entries: [], freezes: [], now: NOW, windowDays: 7 });
  assert.deepEqual(m.streak, { na: 'intervention ledger is empty' });
  const noRepair = selfMetrics({ entries: [entries[2]], freezes: [], now: NOW, windowDays: 7 });
  assert.deepEqual(noRepair.internalizedShare, { na: 'no self-repair entries' });
});

test('status exposes selfSupervision in JSON and as one text line, with tokens and first-pass from #337', async (t) => {
  const withUsage = await mkdtemp(join(tmpdir(), 'rt-self-status-'));
  const withoutUsage = await mkdtemp(join(tmpdir(), 'rt-self-status-'));
  t.after(() => Promise.all([rm(withUsage, { recursive: true, force: true }), rm(withoutUsage, { recursive: true, force: true })]));
  const seed = async (root, { usage }) => {
    await mkdir(join(root, 'state'), { recursive: true });
    await mkdir(join(root, '.roundtable', 'state'), { recursive: true });
    await writeFile(join(root, '.roundtable', 'state', 'interventions.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    await writeFile(join(root, '.roundtable', 'state', 'freeze-ledger.jsonl'), '');
    await writeFile(join(root, 'state', '101.json'), JSON.stringify({ id: '101', status: 'done', gateRecord: { passed: ['gate1'] },
      ledger: [{ id: 'merged:1', type: 'merged', at: Date.UTC(2026, 10, 14, 10) }], lastEvent: { type: 'merged', at: Date.UTC(2026, 10, 14, 10) } }));
    if (usage) {
      await mkdir(join(root, 'state', 'usage'));
      await writeFile(join(root, 'state', 'usage', '101.json'), JSON.stringify([{ issue: 101, role: 'developer', model: 'm', inputTokens: 100, outputTokens: 20,
        usageKnown: true, wallMs: 1000, at: Date.UTC(2026, 10, 14, 9) }]));
    }
  };
  const sources = { async github() { return { issues: [], queue: [] }; } };
  await seed(withUsage, { usage: true });
  await seed(withoutUsage, { usage: false });

  const snapshot = await collectStatus({ workRoot: withUsage, sources, now: () => NOW });
  const json = JSON.parse(JSON.stringify(snapshot));
  assert.equal(json.selfSupervision.tokensPerMergedPr, 120);
  assert.equal(json.selfSupervision.firstPassRate, 1);
  assert.equal(json.selfSupervision.mtbi.bound, null);
  assert.deepEqual(json.selfSupervision.pullIns.owner, { total: 2, byCategory: { decision: 1, 'self-review': 1 } });
  const text = formatStatus(snapshot);
  assert.equal(text.split('\n').filter((line) => line.startsWith('selfSupervision:')).length, 1);

  const bare = await collectStatus({ workRoot: withoutUsage, sources, now: () => NOW });
  assert.deepEqual(bare.selfSupervision.tokensPerMergedPr, { na: 'usage ledger not present' });
  assert.deepEqual(bare.selfSupervision.firstPassRate, { na: 'usage ledger not present' });
  assert.equal(bare.selfSupervision.streak, 33);
});
