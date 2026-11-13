import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCiFixtures, MAX_REPRO_DRAFTS_PER_PR, saveReproDraft } from '../../runtime/lib/ci-classifier.mjs';

const observationsFor = (signature) => [
  { workflow: 'ci', platform: 'linux', status: 'failed', signature },
  { workflow: 'ci', platform: 'macos', status: 'green' },
];

const onePlatform = [
  { workflow: 'ci', platform: 'linux', status: 'failed', signature: 'assertion mismatch at test A' },
  { workflow: 'ci', platform: 'macos', status: 'green' },
];

test('cross-platform failure is a likely code defect; no platform draft classification', () => {
  const result = classifyCiFixtures([
    { workflow: 'linux-ci', platform: 'linux', status: 'failed', signature: 'same assertion' },
    { workflow: 'mac-ci', platform: 'macos', status: 'failed', signature: 'same assertion' },
  ])[0];
  assert.equal(result.classification, 'likely_code_defect');
});

test('single-platform signature with another green platform is platform-specific', () => {
  assert.equal(classifyCiFixtures(onePlatform)[0].classification, 'likely_platform_specific');
});

test('transient and unknown signatures never qualify for a platform draft', () => {
  for (const signature of ['flaky retry', 'timeout waiting', 'runner-lost']) {
    assert.equal(classifyCiFixtures([{ workflow: 'ci', platform: 'linux', status: 'failed', signature }])[0].classification, 'transient');
  }
  const unknown = classifyCiFixtures([{ workflow: 'ci', platform: 'linux', status: 'failed', signature: 'opaque failure 91' }])[0];
  assert.equal(unknown.classification, 'unknown');
  assert.match(unknown.record, /Unknown/);
});

test('drafts redact sensitive evidence, wait without an executor, and deduplicate same head/signature', async () => {
  let stored;
  const store = { async load() { return stored; }, async save(_head, value) { stored = structuredClone(value); } };
  const input = { store, head: 'head-1', observations: onePlatform, signature: onePlatform[0].signature, targetEnvironment: 'linux',
    evidence: 'safe fixture', steps: ['run fixture test'] };
  const first = await saveReproDraft(input);
  assert.equal(first.draft.status, 'wait');
  assert.equal(first.draft.decision, 'wait');
  assert.equal((await saveReproDraft(input)).status, 'deduplicated');
  assert.equal(stored.drafts.length, 1);
});

test('draft persistence fails closed and enforces documented per-head total cap', async () => {
  let stored;
  const store = { async load() { return stored; }, async save(_head, value) { stored = value; } };
  await assert.rejects(saveReproDraft({ store, head: 'h', observations: observationsFor('first'), signature: 'first', targetEnvironment: 'linux', evidence: {}, steps: ['repro'] }));
  for (let i = 0; i < MAX_REPRO_DRAFTS_PER_PR; i++) {
    await saveReproDraft({ store, head: 'h', observations: observationsFor(['first', 'second', 'third'][i]), signature: ['first', 'second', 'third'][i], targetEnvironment: 'linux', evidence: 'safe', steps: ['repro'] });
  }
  assert.equal((await saveReproDraft({ store, head: 'h', observations: observationsFor('extra'), signature: 'extra', targetEnvironment: 'linux', evidence: 'safe', steps: ['repro'] })).status, 'capped');
});

test('unrelated green workflow does not imply a platform-specific failure', () => {
  const [result] = classifyCiFixtures([
    { workflow: 'build', platform: 'linux', status: 'failed', signature: 'assertion mismatch' },
    { workflow: 'docs', platform: 'macos', status: 'green' },
  ]);
  assert.equal(result.classification, 'unknown');
  assert.deepEqual(result.greens, []);
});

test('draft storage rejects sensitive fixture content in every text field', async () => {
  const sensitive = ['host.example', 'synthetic-unmarked-secret', 'token=fixture', ['/home', 'fixture', 'project'].join('/'), '192.0.2.9'];
  for (const field of ['signature', 'targetEnvironment', 'evidence', 'steps']) {
    for (const value of sensitive) {
      let stored;
      const store = { async load() { return stored; }, async save(_head, data) { stored = data; } };
      const input = { store, head: 'head-1', observations: onePlatform, signature: onePlatform[0].signature, targetEnvironment: 'linux', evidence: 'safe', steps: ['repro'] };
      input[field] = field === 'steps' ? [value] : value;
      input.observations = observationsFor(input.signature);
      if (field === 'targetEnvironment') input.observations[0].platform = value;
      try { await saveReproDraft(input); } catch { /* rejection is an acceptable fail-closed outcome */ }
      assert.equal(JSON.stringify(stored ?? {}).includes(value), false, `${field} persisted sensitive input`);
    }
  }
});

test('public draft flow rejects classifications other than platform-specific', async () => {
  const cases = [
    [{ workflow: 'ci', platform: 'linux', status: 'failed', signature: 'opaque failure' }],
    [{ workflow: 'ci', platform: 'linux', status: 'failed', signature: 'timeout waiting' }],
    [{ workflow: 'ci', platform: 'linux', status: 'failed', signature: 'same assertion' }, { workflow: 'ci', platform: 'macos', status: 'failed', signature: 'same assertion' }],
  ];
  for (const observations of cases) {
    let writes = 0;
    const store = { async load() {}, async save() { writes++; } };
    try { await saveReproDraft({ store, head: 'h', observations, signature: observations[0].signature, targetEnvironment: 'linux', evidence: 'safe', steps: ['repro'] }); } catch { /* rejection is acceptable */ }
    assert.equal(writes, 0);
  }
});
