import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMergeDecision } from '../../runtime/lib/merge-decision.mjs';

test('an unparseable safety-merge answer is re-asked once with a format reminder without spending budget', async () => {
  const prompts = [];
  const answers = ['looks fine', 'APPROVE-MERGE'];
  const ask = async text => { prompts.push(text); return answers.shift(); };
  const budget = { used: 0, max: 2 };
  const result = await requestMergeDecision({ ask, prompt: 'Merge PR 7?', budget });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Format: answer with a line containing exactly one of APPROVE-MERGE or REJECT-MERGE\./);
  assert.deepEqual(result, { verdict: 'APPROVE-MERGE', reasked: true });
  assert.equal(budget.used, 1);
  assert.equal(await requestMergeDecision({ ask: async () => 'both APPROVE-MERGE and REJECT-MERGE', prompt: 'x', budget: { used: 0, max: 1 } }).then(r => r.verdict), null);
  await assert.rejects(requestMergeDecision({ ask: async () => { throw new Error('ask called'); }, prompt: 'x', budget: { used: 2, max: 2 } }), /decision budget exhausted/);
});
