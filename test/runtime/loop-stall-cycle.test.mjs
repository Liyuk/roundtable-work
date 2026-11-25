import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoopStallCycle } from '../../runtime/lib/loop-stall-cycle.mjs';

const HOUR = 3600000;
const DAY_AT = Date.UTC(2026, 10, 25, 12);
const issue = (number, fields = {}) => ({ number, state: 'OPEN', labels: [], deps: [], ...fields });
const snap = (fields) => ({ at: DAY_AT, awake: true, claimable: 0, activeWorkers: 0, issues: [], verifiedComplete: [], mainRed: false, freezes: [], ...fields });
const idleSnapshot = snap({
  issues: [issue(553, { labels: ['rt:go'], deps: [562] }), issue(562)],
  verifiedComplete: [562],
});

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'loop-stall-cycle-'));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const outboxItems = (root) => lines(join(root, '.roundtable/state/outbox.jsonl')).map((l) => JSON.parse(l)).filter((l) => l.type === 'item').map((l) => l.item);
const tsv = (root) => join(root, '.roundtable/state/self-judgment.tsv');

test('6 idle cycles write one ledger line and one stall-alert, and a restart adds nothing', () => {
  withRoot((root) => {
    for (let cycle = 1; cycle <= 5; cycle++) runLoopStallCycle({ root, snapshot: idleSnapshot, config: {} });
    assert.equal(lines(tsv(root)).length, 0);
    assert.equal(outboxItems(root).length, 0);

    runLoopStallCycle({ root, snapshot: idleSnapshot, config: {} });
    const ledger = lines(tsv(root));
    assert.equal(ledger.length, 1);
    assert.match(ledger[0], /\tidle-backlog\t562\tverified-complete-leaf\tauto-close\tnotice:stall:idle-backlog:562:2026-11-25$/);
    const items = outboxItems(root);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'notification');
    assert.equal(items[0].payload.subtype, 'stall-alert');

    runLoopStallCycle({ root, snapshot: idleSnapshot, config: {} });
    runLoopStallCycle({ root, snapshot: idleSnapshot, config: {} });
    assert.equal(lines(tsv(root)).length, 1);
    assert.equal(outboxItems(root).length, 1);
  });
});

test('a rt:blocked issue waiting 5 h writes one stale-wait ledger line on its first cycle', () => {
  withRoot((root) => {
    const snapshot = snap({ issues: [issue(7, { labels: ['rt:blocked'], since: DAY_AT - 5 * HOUR })] });
    const { firings } = runLoopStallCycle({ root, snapshot, config: {} });
    assert.equal(firings.length, 1);
    const ledger = lines(tsv(root));
    assert.equal(ledger.length, 1);
    assert.match(ledger[0], /\tstale-wait\t7\trt:blocked\t/);
  });
});

test('state persists in loop-stall.json across cycles', () => {
  withRoot((root) => {
    const { state } = runLoopStallCycle({ root, snapshot: idleSnapshot, config: {} });
    assert.equal(state.idleCycles, 1);
    assert.deepEqual(JSON.parse(readFileSync(join(root, '.roundtable/state/loop-stall.json'), 'utf8')), state);
  });
});
