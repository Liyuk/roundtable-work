import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { score } from '../scripts/rt-bench/score.mjs';
import { collect } from '../scripts/rt-bench.mjs';

// Veto cap from docs/autonomy-benchmark.md section 12: a veto row with `at` in (now - 7 d, now] caps overall at 0.

const NOW = Date.parse('2026-11-17T00:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const FRESH = { asOf: NOW - 60_000 };
const iso = (ms) => new Date(ms).toISOString();

// Every sub-metric at level 4: each dimension and overall would be 4 without a veto.
const ALL_FOUR = ['U', 'L', 'I', 'D'].flatMap((dim) => [1, 2, 3].map((i) => ({ id: `${dim}${i}`, level: 4, source: FRESH })));

test('a veto event in the window caps overall at 0 and leaves the dimensions unchanged', () => {
  assert.deepEqual(score(ALL_FOUR, NOW, [{ at: iso(NOW - HOUR) }]), { U: 4, L: 4, I: 4, D: 4, overall: 0 });
});

test('a window with no veto events is not capped', () => {
  assert.deepEqual(score(ALL_FOUR, NOW), { U: 4, L: 4, I: 4, D: 4, overall: 4 });
  assert.equal(score(ALL_FOUR, NOW, []).overall, 4);
});

test('a veto row older than 7 d does not cap', () => {
  assert.equal(score(ALL_FOUR, NOW, [{ at: iso(NOW - 7 * DAY - 1) }]).overall, 4);
});

test('window is (now - 7 d, now]: the start is excluded and the end is included', () => {
  assert.equal(score(ALL_FOUR, NOW, [{ at: iso(NOW - 7 * DAY) }]).overall, 4);
  assert.equal(score(ALL_FOUR, NOW, [{ at: iso(NOW) }]).overall, 0);
});

test('collect reads veto.jsonl: closed kinds only, asOf from the newest counted row, undefined without a ledger', async () => {
  const ws = '/fixture/ws';
  const rows = [
    { v: 1, id: 'a', at: '2026-11-16T10:00:00Z', kind: 'secret-leak', ref: '#1', reason: 'fixture' },
    { v: 1, id: 'b', at: '2026-11-16T12:00:00Z', kind: 'unknown-kind', ref: '#2', reason: 'fixture' },
  ];
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const io = { async readText(path) { return path === join(ws, '.roundtable', 'state', 'veto.jsonl') ? text : null; } };
  const sources = await collect(io, ws);
  assert.deepEqual(sources.vetoes.events.map((e) => e.id), ['a']);
  assert.equal(sources.vetoes.asOf, Date.parse('2026-11-16T10:00:00Z'));
  const none = await collect({ async readText() { return null; } }, ws);
  assert.equal(none.vetoes.asOf, undefined);
  assert.deepEqual(none.vetoes.events, []);
});
