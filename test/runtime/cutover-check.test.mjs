import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCutover } from '../../scripts/cutover-check.mjs';
import { exportDecisions } from '../../scripts/host-decisions-export.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RTD = join(ROOT, 'runtime/rtd.mjs');
const CHECK = join(ROOT, 'scripts/cutover-check.mjs');
const EXPORT = join(ROOT, 'scripts/host-decisions-export.mjs');
const ROUTING = fileURLToPath(new URL('./routing-fixture.json', import.meta.url));
// Runtime lock records live in a private anchor, never in the work root.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-cutover-check-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-15T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW - hours * HOUR);
const CHECKS = ['shadow-coverage', 'shadow-diff', 'heartbeat', 'scheduler-stall', 'inbox-timers-outbox', 'inventory'];
const INVENTORY = [
  '| Tag class | Behavior | Mapping |',
  '|---|---|---|',
  '| codex | Routing was pinned. | superseded by config.env single routing source (#303) |',
  '| ac | Out-of-scope paths are rejected. | `runtime/lib/accept.mjs` + `test/runtime/accept.test.mjs` :: an out-of-scope path rejects without running tests |',
].join('\n');
const HEARTBEAT = {
  schemaVersion: 1, writtenAt: NOW,
  daemon: { pid: 1, lastCycleAt: NOW, state: 'running' },
  frontChief: { session: 'none', lastTurnAt: 0, state: 'gone' },
  lastMaterialProgress: null,
};

// A ready workspace: shadow cycles 72 h apart, a heartbeat, an empty ledger, and non-empty loop state.
async function workspace({ inventory = INVENTORY } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rt-cutover-check-'));
  const workRoot = join(root, '.roundtable');
  const write = async (rel, text, mtime) => {
    const file = join(root, rel);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, text);
    if (mtime) await utimes(file, mtime, mtime);
  };
  await write('.roundtable/shadow/cycle-1.jsonl', '', hoursAgo(72));
  await write('.roundtable/shadow/cycle-2.jsonl', '', hoursAgo(1));
  await write('.roundtable/state/heartbeat.json', JSON.stringify(HEARTBEAT));
  await write('.roundtable/state/event-inbox.jsonl', '{"source_event_id":"e1"}\n');
  await write('.roundtable/state/timers.json', '[]\n');
  await write('.roundtable/state/outbox.jsonl', '{"id":"o1"}\n');
  await write('inventory.md', `${inventory}\n`);
  return { root, workRoot, write, inventoryPath: join(root, 'inventory.md') };
}

const run = async (ws, options = {}) => checkCutover({ workRoot: ws.workRoot, inventoryPath: ws.inventoryPath, now: NOW, ...options });
const byName = (checks) => Object.fromEntries(checks.map((check) => [check.name, check]));

function cli(args) {
  const child = spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });
  return { code: child.status, stdout: child.stdout, stderr: child.stderr };
}

test('exporter: keeps the latest status per issue and survives a truncated multi-byte field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rt-cutover-export-'));
  try {
    // The last row's detail ends in a truncated 3-byte sequence (E2 82 of the euro sign); the file has no final newline.
    const table = Buffer.concat([
      Buffer.from('issue\tstatus\tattempt\tts\tdetail\n21\trunning\t1\tts\tstarted\n21\tdone\t1\tts\tcaf\u00e9\n'),
      Buffer.from('22\theld\t2\tts\t\n24\tstop\t1\tts\tprice '),
      Buffer.from([0xe2, 0x82]),
    ]);
    await writeFile(join(root, 'status.tsv'), table);
    const result = spawnSync(process.execPath, [EXPORT, '--status-tsv', join(root, 'status.tsv'), '--out', join(root, 'live.json')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'live.json'), 'utf8')), { 21: 'done', 22: 'wait', 24: 'stop' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exporter: maps host statuses to decision words, skips unknown ones, and ignores CR at line end', () => {
  assert.deepEqual(exportDecisions('21\tdone\r\n22\tbogus\t1\tts\t\n23\terror\t1\tts\r\n24\tconstructor\t1\tts\t\n25\tout-of-scope\t1\tts\t\n26\trunning\t1\tts\t\n'),
    { 21: 'done', 23: 'ask', 25: 'out-of-scope', 26: 'wait' });
});

test('cutover check: a ready workspace passes every check', async () => {
  const ws = await workspace();
  try {
    const checks = await run(ws);
    assert.deepEqual(checks.map((c) => c.name), CHECKS);
    assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('shadow-coverage: no cycle files, or cycle files less than 48 h apart, fail', async () => {
  const ws = await workspace();
  try {
    await rm(join(ws.workRoot, 'shadow', 'cycle-2.jsonl'));
    assert.equal(byName(await run(ws))['shadow-coverage'].ok, false, 'one cycle file has no span');
    await rm(join(ws.workRoot, 'shadow', 'cycle-1.jsonl'));
    assert.equal(byName(await run(ws))['shadow-coverage'].ok, false, 'no cycle files');
    await ws.write('.roundtable/shadow/cycle-1.jsonl', '', hoursAgo(47));
    await ws.write('.roundtable/shadow/cycle-2.jsonl', '', hoursAgo(0));
    assert.equal(byName(await run(ws))['shadow-coverage'].ok, false, '47 h apart');
    await ws.write('.roundtable/shadow/cycle-1.jsonl', '', hoursAgo(48));
    assert.equal(byName(await run(ws))['shadow-coverage'].ok, true, '48 h apart');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('shadow-diff: an unexplained recent difference fails; explained or old differences do not', async () => {
  const ws = await workspace();
  try {
    const line = '{"issue":"21","shadow":"done","live":"wait"}\n';
    await ws.write('.roundtable/shadow/cycle-2.jsonl', line, hoursAgo(1));
    await ws.write('.roundtable/shadow/cycle-1.jsonl', '{"issue":"22","shadow":"done","live":null}\n', hoursAgo(72));
    assert.equal(byName(await run(ws))['shadow-diff'].ok, false, 'unexplained');
    await ws.write('.roundtable/shadow/explained.json', JSON.stringify([{ issue: '21', reason: 'host waits on owner reply' }]));
    assert.equal(byName(await run(ws))['shadow-diff'].ok, true, 'explained, and the 72 h old file is outside the window');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('shadow-diff: a malformed explained file fails, and an empty reason does not count', async () => {
  const ws = await workspace();
  try {
    await ws.write('.roundtable/shadow/explained.json', '{not json');
    assert.equal(byName(await run(ws))['shadow-diff'].ok, false, 'malformed JSON');
    await ws.write('.roundtable/shadow/explained.json', JSON.stringify([{ issue: '21', reason: '  ' }]));
    await ws.write('.roundtable/shadow/cycle-2.jsonl', '{"issue":"21","shadow":"done","live":"wait"}\n', hoursAgo(1));
    assert.equal(byName(await run(ws))['shadow-diff'].ok, false, 'blank reason');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('heartbeat: a missing or schema-invalid heartbeat fails', async () => {
  const ws = await workspace();
  try {
    await rm(join(ws.workRoot, 'state', 'heartbeat.json'));
    assert.equal(byName(await run(ws)).heartbeat.ok, false, 'missing');
    await ws.write('.roundtable/state/heartbeat.json', JSON.stringify({ ...HEARTBEAT, schemaVersion: 2 }));
    assert.equal(byName(await run(ws)).heartbeat.ok, false, 'invalid schema');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('scheduler-stall: a stall in the last 24 h fails; old stalls and unparseable lines do not', async () => {
  const ws = await workspace();
  try {
    const stall = (start, end) => JSON.stringify({ start, end, class: 'scheduler-stall' });
    await ws.write('.roundtable/state/freeze-ledger.jsonl', `not json\n${stall(NOW - 50 * HOUR, NOW - 48 * HOUR)}\n`);
    assert.equal(byName(await run(ws))['scheduler-stall'].ok, true, 'old stall and garbage line');
    await ws.write('.roundtable/state/freeze-ledger.jsonl', `${stall(NOW - 2 * HOUR, NOW - HOUR)}\n`);
    assert.equal(byName(await run(ws))['scheduler-stall'].ok, false, 'recent stall');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('inbox-timers-outbox: an empty or missing state file fails', async () => {
  const ws = await workspace();
  try {
    await ws.write('.roundtable/state/outbox.jsonl', '  \n');
    const check = byName(await run(ws))['inbox-timers-outbox'];
    assert.equal(check.ok, false);
    assert.match(check.detail, /outbox\.jsonl/);
    await rm(join(ws.workRoot, 'state', 'timers.json'));
    assert.equal(byName(await run(ws))['inbox-timers-outbox'].ok, false, 'missing timers');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('inventory: a row without a reference, or a not-ported row, fails and names the tag', async () => {
  const bare = await workspace({ inventory: [
    '| Tag class | Behavior | Mapping |', '|---|---|---|',
    '| waitguard | Bounded wait. | not ported: pending #333 |',
    '| ghost | Missing file. | `runtime/lib/nope.mjs` + `test/runtime/accept.test.mjs` :: an out-of-scope path rejects without running tests |',
  ].join('\n') });
  try {
    const check = byName(await run(bare)).inventory;
    assert.equal(check.ok, false);
    assert.match(check.detail, /waitguard/);
    assert.match(check.detail, /ghost/);
  } finally { await rm(bare.root, { recursive: true, force: true }); }
});

test('inventory: a not-needed row with a reason passes', async () => {
  const ws = await workspace({ inventory: [
    '| Tag class | Behavior | Mapping |', '|---|---|---|',
    '| tmpclean | Prune leaked temp dirs. | not ported: pruning is outside the runtime; not needed after cutover: the host prunes its own temp dirs |',
  ].join('\n') });
  try {
    assert.equal(byName(await run(ws)).inventory.ok, true);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('CLI: exit 0 with PASS lines when ready; exit 1 with a FAIL line per failed check; exit 2 on usage', async () => {
  const ws = await workspace();
  try {
    const ready = cli(['--work-root', ws.workRoot, '--inventory', ws.inventoryPath]);
    assert.equal(ready.code, 0, ready.stderr);
    assert.equal(ready.stdout.match(/^PASS /gm).length, CHECKS.length);

    await rm(join(ws.workRoot, 'state', 'heartbeat.json'));
    const failed = cli(['--work-root', ws.workRoot, '--inventory', ws.inventoryPath]);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /^FAIL heartbeat: /m);
    assert.equal(failed.stdout.match(/^PASS /gm).length, CHECKS.length - 1);

    assert.equal(cli(['--work-root', ws.workRoot]).code, 2, 'missing --inventory');
    assert.equal(cli(['--bogus']).code, 2, 'unknown option');
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('CLI: a work root not named .roundtable is a usage error, even when its state files exist', async () => {
  const ws = await workspace();
  try {
    const other = join(ws.root, 'work');
    await cp(ws.workRoot, other, { recursive: true });
    const result = cli(['--work-root', other, '--inventory', ws.inventoryPath]);
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stderr, /\.roundtable/);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

test('CLI on the repository inventory: the rows that name no resolution fail the inventory check', async () => {
  const ws = await workspace();
  try {
    const result = cli(['--work-root', ws.workRoot, '--inventory', join(ROOT, 'docs/host-patch-inventory.md')]);
    assert.equal(result.code, 1);
    // Rows in the #391 form now resolve; the rows still naming an issue (series, waitguard, subretry, tmpclean) keep failing.
    assert.match(result.stdout, /^FAIL inventory: .*\bseries\b/m);
    assert.doesNotMatch(result.stdout, /\bauthor\b/);
  } finally { await rm(ws.root, { recursive: true, force: true }); }
});

// rtd fixtures: the same shape as test/runtime/cutover.test.mjs, so a shadow run is a real pass.
const ADMISSIBLE = '## Goal\nFixture task.\n\n## Acceptance criteria\nRun: `node --test test/runtime/cutover-check.test.mjs`; Expected: exit 0.\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 10\nFiles: 1';
const RATIONALE = 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.';
const PASS = '审查结论：通过';
const SHA = 'a'.repeat(40);
const READS = ['repo view', 'issue list', 'issue view', 'pr list'];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rt-cutover-check-run-'));
  const repo = join(root, 'repo'), workRoot = join(root, 'work'), bin = join(root, 'bin');
  await mkdir(repo); await mkdir(workRoot); await mkdir(bin);
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-b', 'main'); await writeFile(join(repo, 'file'), 'fixture'); git('add', 'file');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  return { root, repo, workRoot, bin, ghLog: join(root, 'gh.log'), providerLog: join(root, 'providers.log') };
}

// Fake gh: one admissible, unclaimed issue for the reads; every call is recorded.
async function fakeGh({ bin, ghLog }) {
  const issue = { id: '21', number: 21, state: 'OPEN', author: { login: 'owner' }, title: '[A] cutover', body: ADMISSIBLE, createdAt: '2020-01-01', labels: [{ name: 'type:feature' }], comments: [] };
  const answers = { 'repo view': { owner: { login: 'owner' } }, 'issue list': [issue], 'issue view': { comments: [], state: 'OPEN', labels: [] }, 'pr list': [], 'issue edit': '', 'issue comment': '' };
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify(args) + '\\n');
const answers = ${JSON.stringify(answers)};
const key = args.slice(0, 2).join(' ');
if (!(key in answers)) { console.error('unexpected gh call'); process.exit(1); }
console.log(typeof answers[key] === 'string' ? answers[key] : JSON.stringify(answers[key]));
`);
  await chmod(join(bin, 'gh'), 0o755);
}

async function fakeProviders({ root, providerLog }) {
  const providers = join(root, 'providers.mjs');
  await writeFile(providers, `import { appendFileSync } from 'node:fs';
const log = (entry) => appendFileSync(${JSON.stringify(providerLog)}, JSON.stringify(entry) + '\\n');
const SHA = ${JSON.stringify(SHA)};
const stub = () => { throw new Error('not reached in the cutover fixture'); };
export default {
  context: { async get() { return { pr: 90, head: SHA, tree: 'tree1', highRisk: true, changedFiles: ['runtime/rtd.mjs'] }; } },
  gates: {
    async gate0() { log('gate0'); return true; },
    async reviewer() { log('gate1'); return { passed: true, head: SHA, rationale: ${JSON.stringify(RATIONALE)} }; },
    async crossCheck() { log('gate2'); return true; },
  },
  github: {
    async getPullRequest() { return { state: 'open', body: 'Closes #21', draft: false, mergeable: true, head: SHA, files: ['runtime/rtd.mjs'], ownerLogin: 'owner', comments: [] }; },
    async requiredGreen() { return true; },
    async squashMerge(pr) { log(['squash', pr]); return { mergeCommit: 'abcdef0123456789' }; },
    async addLabel() {}, async setBase() {}, async recordedEscalationApproval() { return null; }, async createComment() {},
    async mainStatus() { return { head: 'abcdef0123456789', status: 'green' }; },
    openRevertPullRequest: stub, createIssue: stub,
  },
  git: { createRevert: stub },
  observation: {
    expectedSha() { return SHA; },
    issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
    worktree: { async inspect() { return { dirty: false }; } },
    git: { async head() { return SHA; }, async commit() { return { sha: SHA }; } },
    evidence: { async checks() { return { sha: SHA, conclusion: 'success' }; }, async review() { return { sha: SHA, conclusion: 'approved' }; } },
  },
};
`);
  const handler = join(root, 'handler.mjs');
  await writeFile(handler, `export default async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? ${JSON.stringify(PASS)} : 'ok' });\nexport async function preDispatch() { return { ok: true }; }\n`);
  return { providers, handler };
}

function runRtd(args, bin) {
  const child = spawn(process.execPath, [RTD, ...args], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
}

async function runShadow(f, extra) {
  await fakeGh(f);
  const { providers, handler } = await fakeProviders(f);
  return runRtd(['--work-root', f.workRoot, '--github', '--repo', 'owner/repo', '--repo-root', f.repo, '--handler', handler, '--providers', providers, '--routing', ROUTING, ...extra], f.bin);
}

test('--exclusive-with: a pid file naming a live process refuses with exit 2 before any side effect', async () => {
  const f = await fixture();
  try {
    const pidfile = join(f.root, 'host.pid');
    await writeFile(pidfile, `${process.pid}\n`);
    const result = await runShadow(f, ['--exclusive-with', pidfile]);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, new RegExp(pidfile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await assert.rejects(readFile(join(f.workRoot, 'shadow', 'cycle-1.jsonl'), 'utf8'), { code: 'ENOENT' }, 'no shadow cycle is written');
    await assert.rejects(readFile(f.ghLog, 'utf8'), { code: 'ENOENT' }, 'gh is never called');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('--exclusive-with: a pid file that does not hold a positive integer pid refuses with exit 2', async () => {
  const f = await fixture();
  try {
    const pidfile = join(f.root, 'host.pid');
    await writeFile(pidfile, 'host-loop\n');
    assert.equal((await runShadow(f, ['--exclusive-with', pidfile])).code, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('--exclusive-with: a pid file naming an exited child lets a shadow run start', async () => {
  const f = await fixture();
  try {
    const child = spawn(process.execPath, ['-e', '']);
    await once(child, 'exit');
    const pidfile = join(f.root, 'host.pid');
    await writeFile(pidfile, `${child.pid}\n`);
    const result = await runShadow(f, ['--exclusive-with', pidfile]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).outcomes[0].status, 'done');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
