import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGates } from '../../runtime/lib/gates.mjs';
import { createMergeEntryPoint } from '../../runtime/lib/merge.mjs';
import { loadLocalChecksConfig, localCheckEntry, localCheckPasses, ciAllowsMerge } from '../../runtime/lib/local-checks.mjs';
import { buildPrRecord, upsertPrRecord } from '../../runtime/lib/pr-record.mjs';

const RATIONALE = 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.';
const LOCAL = { enabled: true, command: 'npm run check' };
const absent = { green: false, status: 'absent' };

function fixture({ checks = absent, localChecks = LOCAL, localCheck, head = 'abc1234', ledgerEntries = [] } = {}) {
  const calls = [];
  const ledger = [...ledgerEntries];
  const records = new Map();
  const store = {
    async load() { return { ledger }; },
    async append(_id, entry) { if (!ledger.some((e) => e.id === entry.id)) ledger.push(entry); },
  };
  const input = {
    issue: '58', head, tree: 'tree-a', changedFiles: ['docs/notes.md'], pr: 90,
    localChecks, store,
    state: { async get(id) { return records.get(id); }, async put(id, value) { records.set(id, structuredClone(value)); } },
    gates: {
      async gate0() { return { passed: true }; },
      async reviewer() { return { passed: true, head, rationale: RATIONALE }; },
      ...(localCheck && { localCheck: async (args) => { calls.push(['localCheck', args]); return localCheck(args); } }),
    },
    ci: { async requiredGreen() { calls.push('ci'); return checks; } },
    merge: { async squash(pr, evidence) { calls.push(['merge', pr, evidence.ciGreen]); return { merged: true }; } },
    github: {
      async getPullRequest() { return { body: 'Closes #58' }; },
      async recordedEscalationApproval() { return null; },
      async addLabel() {},
    },
  };
  return { input, calls, ledger };
}

const recorded = (head = 'abc1234') => localCheckEntry({ head, tree: 'tree-a', command: 'npm run check' });

test('config loader reads the default file as disabled with the documented command', async () => {
  const config = await loadLocalChecksConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.command, 'npm run check');
  assert.equal(typeof config.description, 'string');
});

test('config loader fails closed on a missing file, a non-boolean enabled, or an empty command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt58-cfg-'));
  try {
    const write = async (name, value) => { const path = join(dir, name); await writeFile(path, JSON.stringify(value)); return path; };
    await assert.rejects(loadLocalChecksConfig(join(dir, 'missing.json')));
    await assert.rejects(loadLocalChecksConfig(await write('string.json', { enabled: 'true', command: 'npm run check' })));
    await assert.rejects(loadLocalChecksConfig(await write('empty.json', { enabled: true, command: '' })));
    await assert.rejects(loadLocalChecksConfig(await write('blank.json', { enabled: true, command: '   ' })));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('enabled with a local check recorded for the current head lets the CI step merge via runGates', async () => {
  const f = fixture({ ledgerEntries: [recorded()] });
  const result = await runGates(f.input);
  assert.equal(result.status, 'merged');
  assert.deepEqual(f.calls.filter((c) => c === 'ci' || c[0] === 'merge'), ['ci', ['merge', 90, true]]);
});

test('enabled with absent CI runs the injected local check, records it, and merges', async () => {
  const f = fixture({ localCheck: async () => ({ exitCode: 0 }) });
  const result = await runGates(f.input);
  assert.equal(result.status, 'merged');
  assert.deepEqual(f.calls.find((c) => c[0] === 'localCheck'), ['localCheck', { issue: '58', head: 'abc1234', tree: 'tree-a', command: 'npm run check' }]);
  assert.ok(f.ledger.some((e) => e.id === 'local-check:abc1234' && e.type === 'local_check' && e.detail.ok === true));
});

test('a non-zero local check blocks without holding', async () => {
  const f = fixture({ localCheck: async () => ({ exitCode: 1 }) });
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.hold, false);
  assert.equal(f.calls.some((c) => c[0] === 'merge'), false);
  assert.equal(f.ledger.length, 0);
});

test('a throwing local check holds the gate', async () => {
  const f = fixture({ localCheck: async () => { throw new Error('runner offline'); } });
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.hold, true);
});

test('a record for an old head does not satisfy a new head', async () => {
  const f = fixture({ ledgerEntries: [recorded('old5678')] });
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.hold, false);
  assert.equal(f.calls.some((c) => c[0] === 'merge'), false);
});

test('required CI red still blocks even with a current-head record', async () => {
  for (const checks of [{ green: false }, { green: false, status: 'red' }]) {
    const f = fixture({ checks, ledgerEntries: [recorded()] });
    const result = await runGates(f.input);
    assert.equal(result.status, 'blocked');
    assert.equal(result.hold, false);
  }
});

test('pending and timeout CI still hold even with a current-head record', async () => {
  for (const status of ['pending', 'timeout']) {
    const f = fixture({ checks: { green: false, status }, ledgerEntries: [recorded()] });
    const result = await runGates(f.input);
    assert.equal(result.status, 'blocked');
    assert.equal(result.hold, true);
  }
});

test('disabled local checks block absent CI even with a record', async () => {
  const f = fixture({ localChecks: { enabled: false, command: 'npm run check' }, ledgerEntries: [recorded()] });
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.hold, false);
});

test('enabled with absent CI, no record and no local check provider blocks (fail closed)', async () => {
  const f = fixture();
  const result = await runGates(f.input);
  assert.equal(result.status, 'blocked');
  assert.equal(result.hold, false);
});

test('pure helpers: a record counts only for its own head and only when it reports ok', () => {
  assert.equal(localCheckPasses([recorded('abc1234')], 'abc1234'), true);
  assert.equal(localCheckPasses([recorded('abc1234')], 'other99'), false);
  assert.equal(localCheckPasses([], 'abc1234'), false);
  assert.equal(ciAllowsMerge({ checks: absent, enabled: false, ledger: [recorded()], head: 'abc1234' }), false);
  assert.equal(ciAllowsMerge({ checks: absent, enabled: true, ledger: [recorded()], head: 'abc1234' }), true);
  assert.equal(ciAllowsMerge({ checks: true, enabled: false, ledger: [], head: 'abc1234' }), true);
});

const persisted = { issue: '58', head: 'abc1234', tree: 'tree-a', passed: ['gate0', 'gate1', 'ci'], safetyFiles: [], safetyApproved: false };
const evidence = { issue: '58', head: 'abc1234', tree: 'tree-a', highRisk: false, passed: ['gate0', 'gate1', 'ci'], ciGreen: true };

function mergeFixture({ checks = absent, localChecks = LOCAL, ledgerEntries = [] } = {}) {
  const calls = [];
  const body = upsertPrRecord('Closes #58', buildPrRecord({ issue: '58', head: 'abc1234', tree: 'tree-a', passed: persisted.passed }));
  const ledger = [...ledgerEntries];
  const entry = createMergeEntryPoint({
    mode: 'agent', localChecks,
    gateState: { async get() { return persisted; } },
    store: { async load() { return { ledger }; }, async append() {} },
    github: {
      async getPullRequest() { return { body, state: 'open', draft: false, head: 'abc1234', mergeable: true, files: [] }; },
      async requiredGreen() { return checks; },
      async squashMerge(_pr, options) { calls.push(options); return 'merged'; },
    },
  });
  return { entry, calls };
}

test('merge entry point accepts absent CI only with a current-head local check record', async () => {
  const accepted = mergeFixture({ ledgerEntries: [recorded()] });
  assert.equal(await accepted.entry(90, evidence), 'merged');
  assert.equal(accepted.calls.length, 1);

  const noRecord = mergeFixture();
  await assert.rejects(noRecord.entry(90, evidence), /Required CI is red or pending/);
  assert.equal(noRecord.calls.length, 0);

  const staleRecord = mergeFixture({ ledgerEntries: [recorded('old5678')] });
  await assert.rejects(staleRecord.entry(90, evidence), /Required CI is red or pending/);

  const disabled = mergeFixture({ localChecks: { enabled: false, command: 'npm run check' }, ledgerEntries: [recorded()] });
  await assert.rejects(disabled.entry(90, evidence), /Required CI is red or pending/);
  assert.equal(disabled.calls.length, 0);
});

test('merge entry point still rejects red CI even with a current-head local check record', async () => {
  const red = mergeFixture({ checks: { green: false, status: 'red' }, ledgerEntries: [recorded()] });
  await assert.rejects(red.entry(90, evidence), /Required CI is red or pending/);
  assert.equal(red.calls.length, 0);
});
