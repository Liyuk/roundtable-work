import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeRisk } from '../../runtime/lib/merge-risk.mjs';

// Merge-risk labelling seam: each fixture pins one rule (or the CI raise) with an independent expected label and reason list.
const dir = join(import.meta.dirname, '../fixtures/merge-risk');

for (const name of readdirSync(dir).filter(file => file.endsWith('.json'))) {
  test(`merge-risk fixture: ${name}`, () => {
    const { facts, expected } = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const first = mergeRisk(facts);
    assert.equal(first.label, expected.label);
    assert.deepEqual(first.reasons, expected.reasons);
    assert.deepEqual(mergeRisk(facts), first);
  });
}
