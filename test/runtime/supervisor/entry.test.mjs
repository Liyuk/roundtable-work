import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCycle, parseArgs, main } from '../../../runtime/supervise.mjs';
import { createLedger, parseLedger } from '../../../runtime/supervisor/ledger.mjs';
import { HEARTBEAT_PATH } from '../../../runtime/supervisor/heartbeat.mjs';

const DAY = 86_400_000;
const NOW = 10 * DAY;
const counter = () => { let n = 0; return () => `id-${++n}`; };
const staleHeartbeat = JSON.stringify({
  schemaVersion: 1, writtenAt: 0,
  daemon: { pid: 1, lastCycleAt: 0, state: 'running' },
  frontChief: { session: 'front-chief', lastTurnAt: 0, state: 'active' },
  lastMaterialProgress: null,
});
const freshHeartbeat = JSON.stringify({
  schemaVersion: 1, writtenAt: NOW,
  daemon: { pid: 1, lastCycleAt: NOW, state: 'running' },
  frontChief: { session: 'front-chief', lastTurnAt: NOW, state: 'active' },
  lastMaterialProgress: null,
});
const fixture = { issues: [{ number: 253 }], pulls: [{ number: 9, headSha: 'abc' }], checks: { abc: [] }, comments: [] };

const setup = () => {
  const entries = [];
  const ledger = createLedger({ append: (line) => entries.push(JSON.parse(line)), newId: counter(), now: () => NOW });
  const calls = [];
  const actuator = { act: async (req) => { calls.push(req); return { status: 'done' }; } };
  const github = { listIssues: async () => fixture.issues, listPulls: async () => fixture.pulls,
    listChecks: async (sha) => fixture.checks[sha], listComments: async () => fixture.comments };
  return { entries, ledger, calls, actuator, github };
};

const inputs = ({ heartbeat = staleHeartbeat, github, pauseProvenance } = {}) => ({
  now: NOW,
  readHeartbeat: async () => heartbeat,
  readDaemonState: async () => null,
  readDaemonLog: async () => null,
  github,
  pauseProvenance,
});

test('observe cycle on a stale heartbeat records a root and observe-only decisions on one trace', async () => {
  const { entries, ledger, calls, actuator, github } = setup();
  const result = await runCycle({ mode: 'observe', now: NOW, collectInputs: inputs({ github }), ledger, actuator });
  const [root, ...decisions] = entries;
  assert.equal(root.action, 'cycle');
  assert.equal(root.parentId, null);
  assert.equal(result.rootId, root.id);
  assert.equal(result.traceId, root.traceId);
  assert.deepEqual(result.findings, ['heartbeat-stale', 'heartbeat-stale']);
  assert.equal(decisions.length, 2);
  for (const d of decisions) {
    assert.equal(d.action, 'observe-only');
    assert.equal(d.mode, 'observe');
    assert.equal(d.parentId, root.id);
    assert.equal(d.traceId, root.traceId);
  }
  assert.equal(result.decisions.length, 3);
  assert.equal(calls.length, 0);
});

test('apply cycle with a stale pause calls the actuator once with void-stale-pause and awaits it', async () => {
  const { entries, ledger, calls, actuator, github } = setup();
  let resolved = false;
  actuator.act = async (req) => { calls.push(req); await new Promise((r) => setTimeout(r, 5)); resolved = true; return { status: 'done' }; };
  const pauseProvenance = { at: 0, ref: 'pause-1' };
  await runCycle({ mode: 'apply', now: NOW, collectInputs: inputs({ heartbeat: freshHeartbeat, github, pauseProvenance }), ledger, actuator });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'void-stale-pause');
  assert.deepEqual(calls[0].args, { ref: 'pause-1' });
  assert.equal(resolved, true);
  assert.equal(entries.find((e) => e.action === 'requeue').mode, 'apply');
});

test('an auditor must have a non-empty name and an audit function', async () => {
  const { ledger, actuator, github } = setup();
  const base = { mode: 'observe', now: NOW, collectInputs: inputs({ github }), ledger, actuator };
  await assert.rejects(runCycle({ ...base, auditor: { audit: () => [] } }), TypeError);
  await assert.rejects(runCycle({ ...base, auditor: { name: '', audit: () => [] } }), TypeError);
  await assert.rejects(runCycle({ ...base, auditor: { name: 'a' } }), TypeError);
});

test('auditor notes are recorded observe-only, get read-only input, and cannot act', async () => {
  const { entries, ledger, calls, actuator, github } = setup();
  const seen = [];
  const auditor = {
    name: 'grader',
    audit: async (input) => { seen.push(input); return ['looks fine']; },
  };
  await runCycle({ mode: 'observe', now: NOW, collectInputs: inputs({ github }), ledger, actuator, auditor });
  assert.equal(Object.isFrozen(seen[0]), true);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['checks', 'comments', 'issues', 'pulls']);
  const note = entries.find((e) => e.findingSignature === 'auditor:grader');
  assert.equal(note.action, 'observe-only');
  assert.equal(note.reason, 'auditor grader: looks fine');
  assert.equal(note.parentId, entries[0].id);
  assert.equal(note.traceId, entries[0].traceId);
  assert.equal(calls.length, 0);
});

test('parseArgs defaults to observe and accepts the documented flags', () => {
  assert.deepEqual(parseArgs(['--workspace', '/w']), { mode: 'observe', workspace: '/w', issue: null, githubFixture: undefined });
  assert.deepEqual(parseArgs(['--mode', 'apply', '--workspace', '/w', '--issue', '7', '--github-fixture', 'f.json']),
    { mode: 'apply', workspace: '/w', issue: 7, githubFixture: 'f.json' });
});

test('parseArgs rejects unknown modes, unknown args, bad issues and a missing workspace', () => {
  assert.throws(() => parseArgs(['--workspace', '/w', '--mode', 'yolo']), TypeError);
  assert.throws(() => parseArgs(['--workspace', '/w', '--bogus', 'x']), TypeError);
  assert.throws(() => parseArgs(['--workspace', '/w', '--issue', '0']), TypeError);
  assert.throws(() => parseArgs(['--mode', 'observe']), TypeError);
});

test('main runs one observe cycle and writes only the ledger (plus the test-written fixtures)', async () => {
  const work = mkdtempSync(join(tmpdir(), 'sup-entry-'));
  const ws = join(work, 'ws');
  const fixtures = join(work, 'fixtures');
  try {
    mkdirSync(join(ws, '.roundtable/state'), { recursive: true });
    mkdirSync(fixtures);
    writeFileSync(join(ws, HEARTBEAT_PATH), staleHeartbeat);
    const githubFile = join(fixtures, 'github.json');
    writeFileSync(githubFile, JSON.stringify(fixture));
    const out = [];
    const result = await main(['--workspace', ws, '--github-fixture', githubFile], { now: () => NOW, stdout: (s) => out.push(s) });
    assert.equal(result.mode, 'observe');
    assert.equal(result.decisions.length, 3);
    assert.equal(JSON.parse(out.join('')).traceId, result.traceId);
    const ledger = parseLedger(readFileSync(join(ws, '.roundtable/state/supervisor-ledger.jsonl'), 'utf8'));
    assert.equal(ledger.filter((e) => e.action === 'cycle').length, 1);
    const files = (await readdir(ws, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(ws.length + 1)).sort();
    assert.deepEqual(files, [HEARTBEAT_PATH, '.roundtable/state/supervisor-ledger.jsonl']);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('main refuses --mode apply and a run without a GitHub fixture', async () => {
  await assert.rejects(main(['--workspace', '/w', '--mode', 'apply', '--github-fixture', 'f.json']), /apply needs live actuator adapters/);
  await assert.rejects(main(['--workspace', '/w']), /no GitHub source configured/);
});

test('the systemd unit template is a placeholder-only, oneshot, not-installed template', () => {
  const unit = readFileSync(new URL('../../../deploy/systemd/rt-supervisor.service', import.meta.url), 'utf8');
  assert.match(unit, /^Type=oneshot$/m);
  assert.match(unit, /^User=<supervisor-user>$/m);
  assert.match(unit, /^EnvironmentFile=-<env-file>$/m);
  assert.doesNotMatch(unit, /\/home\/|\/root\/|\/Users\//);
  assert.doesNotMatch(unit, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(unit, /\[Install\]/);
  for (const placeholder of unit.match(/<[^>]*>/g)) assert.match(placeholder, /^<[a-z-]+>$/);
});

test('docs/supervisor.md contains no IP addresses, host names or home paths', () => {
  const doc = readFileSync(new URL('../../../docs/supervisor.md', import.meta.url), 'utf8');
  assert.doesNotMatch(doc, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  assert.doesNotMatch(doc, /\/home\//);
});
