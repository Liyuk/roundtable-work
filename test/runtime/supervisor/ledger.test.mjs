import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger, fileAppender, parseLedger, LEDGER_PATH } from '../../../runtime/supervisor/ledger.mjs';

const counter = () => { let n = 0; return () => `id-${++n}`; };
const valid = { mode: 'observe', action: 'void-stale-pause', reason: 'stale pause ref abc', findingSignature: 'pause-provenance-stale:abc' };

test('the ledger path is the fixed supervisor state file', () => {
  assert.equal(LEDGER_PATH, '.roundtable/state/supervisor-ledger.jsonl');
});

test('record stores every field and writes exactly one JSON line through append', () => {
  const lines = [];
  const ledger = createLedger({ append: (line) => lines.push(line), newId: counter(), now: () => 42 });
  const stored = ledger.record(valid);
  assert.deepEqual(stored, { id: 'id-1', traceId: 'id-2', parentId: null, at: 42, ...valid });
  assert.deepEqual(lines, [JSON.stringify(stored) + '\n']);
});

test('record keeps a given traceId and parentId', () => {
  const lines = [];
  const ledger = createLedger({ append: (line) => lines.push(line), newId: counter(), now: () => 1 });
  const stored = ledger.record({ ...valid, traceId: 'trace-x', parentId: 'parent-y' });
  assert.equal(stored.traceId, 'trace-x');
  assert.equal(stored.parentId, 'parent-y');
});

test('record rejects an invalid mode and a missing action', () => {
  const ledger = createLedger({ append: () => {}, newId: counter(), now: () => 1 });
  assert.throws(() => ledger.record({ ...valid, mode: 'delete' }), TypeError);
  assert.throws(() => ledger.record({ ...valid, action: '' }), TypeError);
  assert.throws(() => ledger.record({ ...valid, action: undefined }), TypeError);
  assert.throws(() => ledger.record({ ...valid, reason: '' }), TypeError);
  assert.throws(() => ledger.record({ ...valid, findingSignature: '' }), TypeError);
});

test('record never rewrites earlier content: each append extends the file as an exact prefix', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  try {
    const file = join(dir, 'ledger.jsonl');
    const ledger = createLedger({ append: fileAppender(file), newId: counter(), now: () => 7 });
    ledger.record(valid);
    const before = readFileSync(file, 'utf8');
    ledger.record({ ...valid, action: 'observe-only' });
    const after = readFileSync(file, 'utf8');
    assert.ok(after.startsWith(before));
    assert.equal(after.split('\n').length - 1, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseLedger round-trips what record wrote, ignoring the trailing empty line', () => {
  const lines = [];
  const ledger = createLedger({ append: (line) => lines.push(line), newId: counter(), now: () => 9 });
  const a = ledger.record(valid);
  const b = ledger.record({ ...valid, action: 'requeue', parentId: a.id, traceId: a.traceId });
  assert.deepEqual(parseLedger(lines.join('')), [a, b]);
});

test('ledger fixtures contain no secrets', () => {
  const text = JSON.stringify(valid);
  assert.doesNotMatch(text, /token|secret|password|api[_-]?key|sk-/i);
});
