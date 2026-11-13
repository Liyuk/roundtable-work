import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runQueue } from './observation-fixture.mjs';
import { createStateStore } from '../../runtime/lib/state.mjs';

const files = [
  '.agents/skills/roundtable-work/prompts/roles/chief.md',
  '.agents/skills/roundtable-work/prompts/roles/reviewer.md',
  '.roundtable/policy.md',
];
const PASS = '审查结论：通过\nok';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rt-rules-'));
  for (const file of files) {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), file);
  }
  const store = await createStateStore({ workRoot: root });
  await store.save({ ...(await store.load('1')), status: 'stop', rulesFingerprint: 'old',
    attempts: { developer: 2, reviewerUnavailable: 0, wakes: 2 }, lastEvent: { type: 'review_rejected', at: 1, ruleRelated: true } });
  return { root, store };
}

test('changed rules re-evaluate a rule rejection once, while an unchanged fingerprint leaves it terminal', async () => {
  const { root, store } = await fixture();
  let calls = 0;
  try {
    const handler = async ({ phase }) => {
      calls++;
      return { exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' };
    };
    const first = await runQueue({ workRoot: root, queue: ['1'], handler });
    assert.equal(first.outcomes[0].status, 'done', JSON.stringify(first));
    const finished = await store.load('1');
    assert.equal(typeof finished.rulesFingerprint, 'string');
    assert.equal(finished.status, 'done');
    const count = calls;
    const second = await runQueue({ workRoot: root, queue: ['1'], handler });
    assert.equal(second.outcomes[0].skipped, true);
    assert.equal(calls, count);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a rejected re-evaluation is not retried again under the same fingerprint', async () => {
  const { root, store } = await fixture();
  let reviews = 0;
  try {
    const handler = async ({ phase }) => {
      if (phase === 'reviewing') { reviews++; return { exitCode: 0, output: '审查结论：打回\nissue', ruleRelated: true }; }
      return { exitCode: 0, output: 'ok' };
    };
    const result = await runQueue({ workRoot: root, queue: ['1'], handler, maxDeveloperAttempts: 1 });
    assert.equal(result.outcomes[0].status, 'stop');
    assert.equal(reviews, 1);
    assert.equal((await store.load('1')).lastEvent.ruleRelated, true);
    const second = await runQueue({ workRoot: root, queue: ['1'], handler, maxDeveloperAttempts: 1 });
    assert.equal(second.outcomes[0].skipped, true);
    assert.equal(reviews, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rule fingerprint reads repoRoot and re-evaluates an explicitly rule-related rejection once', async () => {
  const { root, store } = await fixture();
  const repoRoot = await mkdtemp(join(tmpdir(), 'rt-rule-source-'));
  let reviews = 0;
  try {
    for (const file of files) {
      await mkdir(join(repoRoot, file, '..'), { recursive: true });
      await writeFile(join(repoRoot, file), file);
    }
    const handler = async ({ phase }) => {
      if (phase === 'reviewing') { reviews++; return { exitCode: 0, output: '审查结论：打回\nissue', ruleRelated: true }; }
      return { exitCode: 0, output: 'ok' };
    };
    await runQueue({ workRoot: root, repoRoot, queue: ['1'], handler, maxDeveloperAttempts: 1 });
    assert.equal(reviews, 1);
    await writeFile(join(repoRoot, files[1]), 'changed source rule');
    const retried = await runQueue({ workRoot: root, repoRoot, queue: ['1'], handler, maxDeveloperAttempts: 1 });
    assert.equal(retried.outcomes[0].status, 'stop');
    assert.equal(reviews, 2);
    assert.equal((await store.load('1')).lastEvent.ruleRelated, true);
    const third = await runQueue({ workRoot: root, repoRoot, queue: ['1'], handler, maxDeveloperAttempts: 1 });
    assert.equal(third.outcomes[0].skipped, true);
    assert.equal(reviews, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test('a changed fingerprint requeues only stopped rule-related records', async () => {
  const { root, store } = await fixture();
  try {
    await store.save({ ...(await store.load('2')), status: 'stop', rulesFingerprint: 'old', lastEvent: { type: 'review_rejected', at: 1 } });
    const state1 = await store.load('1');
    await store.save({ ...state1, lastEvent: { type: 'review_rejected', at: 1, ruleRelated: true } });
    const result = await runQueue({ workRoot: root, queue: [{ id: '1', state: 'stop' }, { id: '2', state: 'stop' }], handler: async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? PASS : 'ok' }) });
    assert.equal(result.status, 'ok');
    assert.equal(result.outcomes[0].status, 'done');
    assert.equal((await store.load('1')).status, 'done');
    assert.equal((await store.load('2')).status, 'stop');
  } finally { await rm(root, { recursive: true, force: true }); }
});
