import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { classify } from '../../runtime/lib/classify.mjs';

const dir = new URL('../fixtures/review-cards/', import.meta.url);
const findings = (text) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(text)[1]).findings;

// Documented in test/fixtures/review-cards/README.md.
const expected = {
  'reject-01-evidenced.md': { cls: 'review_rejected', decision: 'continue', reason: undefined, consumesDeveloperRetry: true },
  'reject-02-unevidenced.md': { cls: 'reviewer_unavailable', decision: 'wait', reason: 'unevidenced_blocking_findings', consumesDeveloperRetry: false },
  'reject-03-mixed.md': { cls: 'reviewer_unavailable', decision: 'wait', reason: 'unevidenced_blocking_findings', consumesDeveloperRetry: false },
};

for (const [name, want] of Object.entries(expected)) {
  test(`replay ${name}`, async () => {
    const output = await readFile(new URL(name, dir), 'utf8');
    const { class: cls, decision, reason, consumesDeveloperRetry } = classify({ stage: 'reviewer', exitCode: 0, output, findings: findings(output) });
    assert.deepEqual({ cls, decision, reason, consumesDeveloperRetry }, want);
  });
}
