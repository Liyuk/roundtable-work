import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, CLASSES, DECISIONS } from '../../runtime/lib/classify.mjs';

const reviewer = (extra) => classify({ stage: 'reviewer', exitCode: 0, ...extra });

test('decision words are kept verbatim', () => {
  assert.deepEqual([...DECISIONS], ['continue', 'wait', 'ask', 'done', 'stop']);
});

test('each failure class is produced by its own trigger and the classes are distinct', () => {
  const outcomes = {
    developer_failure: classify({ stage: 'developer', exitCode: 2 }),
    test_failure: classify({ stage: 'test', exitCode: 1 }),
    reviewer_unavailable: reviewer({ exitCode: 1 }),
    review_rejected: reviewer({ output: '审查结论：打回\nneeds work' }),
    human_block: classify({ stage: 'developer', exitCode: 0, output: 'x', humanBlock: true }),
    scope_mismatch: classify({ stage: 'developer', exitCode: 0, output: 'x', scopeMismatch: true }),
  };
  for (const [expected, got] of Object.entries(outcomes)) {
    assert.equal(got.class, expected);
    assert.ok(CLASSES.includes(expected));
  }
  assert.equal(new Set(Object.values(outcomes).map((o) => o.class)).size, 6);
});

test('reviewer unavailable: nonzero exit, timeout and empty output; never spends a developer retry', () => {
  for (const [event, reason] of [[{ exitCode: 3, output: 'x' }, 'nonzero_exit'], [{ timedOut: true }, 'timeout'], [{ output: '  \n' }, 'empty_output'], [{}, 'empty_output']]) {
    const r = reviewer(event);
    assert.equal(r.class, 'reviewer_unavailable');
    assert.equal(r.reason, reason);
    assert.equal(r.consumesDeveloperRetry, false);
    assert.equal(r.preserveArtifacts, true);
    assert.equal(r.decision, 'wait');
  }
});

test('an unparseable reviewer reply is reviewer-unavailable, not a rejection', () => {
  for (const output of ['looks good to me', '审查结论：maybe', '审查结论：']) {
    const r = reviewer({ output });
    assert.equal(r.class, 'reviewer_unavailable', output);
    assert.equal(r.reason, 'unparseable_verdict');
  }
});

test('verdict line: pass continues, rejection spends a developer retry, block asks a person', () => {
  const pass = reviewer({ output: '审查结论：通过\nfine' });
  assert.deepEqual([pass.class, pass.verdict, pass.consumesDeveloperRetry], ['review_passed', 'passed', false]);
  const rej = reviewer({ output: '\n审查结论：打回\nfix' });
  assert.deepEqual([rej.class, rej.verdict, rej.consumesDeveloperRetry], ['review_rejected', 'rejected', true]);
  const blk = reviewer({ output: '审查结论：阻塞' });
  assert.deepEqual([blk.class, blk.verdict, blk.decision], ['human_block', 'blocked', 'ask']);
  assert.equal(reviewer({ output: '审查结论: 通过' }).class, 'review_passed', 'ASCII colon accepted');
});

test('developer and test failures spend a developer retry; scope mismatch and human block do not', () => {
  assert.equal(classify({ stage: 'developer', timedOut: true }).consumesDeveloperRetry, true);
  assert.equal(classify({ stage: 'developer', exitCode: 0, output: '' }).reason, 'empty_output');
  assert.equal(classify({ stage: 'test', exitCode: 1 }).consumesDeveloperRetry, true);
  assert.equal(classify({ stage: 'test', exitCode: 0 }).class, 'ok');
  assert.equal(classify({ stage: 'reviewer', scopeMismatch: true }).consumesDeveloperRetry, false);
  assert.equal(classify({ stage: 'test', humanBlock: true }).consumesDeveloperRetry, false);
});

test('bad input is rejected', () => {
  assert.throws(() => classify(null), TypeError);
  assert.throws(() => classify({ stage: 'nope' }), TypeError);
});

test('a failed or timed-out finalize step is its own class: asks a person and never spends a developer retry', () => {
  for (const [event, reason] of [[{ exitCode: 1 }, 'nonzero_exit'], [{ timedOut: true }, 'timeout']]) {
    const r = classify({ stage: 'finalize', ...event });
    assert.deepEqual([r.class, r.decision, r.reason, r.consumesDeveloperRetry, r.preserveArtifacts], ['finalize_failure', 'ask', reason, false, true]);
    assert.ok(CLASSES.includes(r.class));
  }
  assert.deepEqual([classify({ stage: 'finalize', exitCode: 0 }).class, classify({ stage: 'finalize', exitCode: 0 }).decision], ['ok', 'done']);
});

test('a rejected verdict whose blocking findings lack evidence is malformed and retries the reviewer', () => {
  const rej = (findings) => reviewer({ output: '审查结论：打回\nneeds work', findings });
  const reason = 'unevidenced_blocking_findings';
  for (const findings of [
    [{ classification: 'blocking', evidence: '' }],
    [{ classification: 'blocking', evidence: '   ' }],
    [{ classification: 'blocking' }],
    [{ classification: 'in-scope miss' }],
    [{ classification: 'blocking', evidence: 'ok' }, { classification: 'in-scope miss' }],
  ]) {
    const r = rej(findings);
    assert.deepEqual([r.class, r.decision, r.reason, r.consumesDeveloperRetry], ['reviewer_unavailable', 'wait', reason, false]);
  }
});

test('a rejection with evidence on every blocking or in-scope finding stays a review rejection', () => {
  const rej = (findings) => reviewer({ output: '审查结论：打回', findings });
  const evidence = 'runtime/lib/classify.mjs:74 — node --test test/runtime/classify.test.mjs → 1 failing';
  assert.equal(rej([{ classification: 'blocking', evidence }]).class, 'review_rejected');
  assert.equal(rej([{ classification: 'in-scope miss', evidence }, { classification: 'out-of-scope follow-up' }]).class, 'review_rejected');
  assert.equal(rej([]).class, 'review_rejected');
  assert.equal(reviewer({ output: '审查结论：打回' }).class, 'review_rejected', 'absent findings keeps the old behavior');
  assert.equal(reviewer({ output: '审查结论：通过', findings: [{ classification: 'blocking' }] }).class, 'review_passed', 'a pass is never malformed by the evidence rule');
  assert.equal(reviewer({ output: '审查结论：阻塞', findings: [{ classification: 'blocking' }] }).class, 'human_block');
});
