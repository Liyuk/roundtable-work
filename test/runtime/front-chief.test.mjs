import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { chmod, access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStatus, renderPrompt, startFrontChief, PROMPT_CAP_TOKENS } from '../../runtime/lib/front-chief.mjs';
import { lockDirectoryFor } from '../../runtime/lib/lock.mjs';
import { main } from '../../bin/rt-chief.mjs';

// Lock records live in a private anchor for the whole file; every work root is its own temporary directory.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-fc-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
after(() => rm(ANCHOR, { recursive: true, force: true }));

const ROLE = '# Chief role\nYou are the front Chief.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true, () => false);
const ledgerPath = (dir) => join(dir, '.roundtable', 'state', 'task-ledger.jsonl');
const sessionPath = (dir) => join(dir, '.roundtable', 'state', 'front-chief-session.json');
const lockPath = (dir) => join(dir, '.roundtable', 'state', 'front-chief.lock.d');
const lockDir = (dir) => lockDirectoryFor({ lockPath: lockPath(dir), repoRoot: dir, anchorRoot: ANCHOR });
const rec = (o) => JSON.stringify({ line: null, decision: null, why: '', pr: null, at: 0, ...o });
const withWs = (fn) => async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rt-fc-ws-'));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};
async function seedLedger(dir, text) {
  await mkdir(join(dir, '.roundtable', 'state'), { recursive: true });
  await writeFile(ledgerPath(dir), text);
}
const collector = () => { const out = []; return { out, write: (s) => out.push(s) }; };

test('status: last record per issue wins, closed issues are not open, invalid lines are counted, open sorted by issue', () => {
  const text = [
    rec({ issue: 7, state: 'working', decision: 'd7', why: 'w', pr: 3 }),
    rec({ issue: 5, state: 'blocked', why: 'x' }),
    rec({ issue: 3, state: 'queued' }),
    rec({ issue: 7, state: 'done' }),
    '{"issue":"9","state":"queued"}',
    '{bad json',
    rec({ issue: 0, state: 'queued' }),
    rec({ issue: 8, state: 'bogus' }),
    rec({ issue: 12, state: 'cancelled' }),
  ].join('\n') + '\n';
  assert.deepEqual(buildStatus(text), {
    openTasks: [
      { issue: 3, state: 'queued', line: null, decision: null, why: '', pr: null },
      { issue: 5, state: 'blocked', line: null, decision: null, why: 'x', pr: null },
    ],
    closedCount: 2,
    invalidLines: 4,
  });
});

test('start: a killed session resumes the same id, and the status is byte-identical', withWs(async (dir) => {
  await seedLedger(dir, rec({ issue: 4, state: 'working', why: 'w' }) + '\n');
  const launches = [];
  await assert.rejects(startFrontChief({ workspace: dir, rolePrompt: ROLE, launch: async (a) => { launches.push(a); throw new Error('killed'); } }), /killed/);
  const before = JSON.stringify(buildStatus(await readFile(ledgerPath(dir), 'utf8')));
  const r = await startFrontChief({ workspace: dir, rolePrompt: ROLE, launch: async (a) => { launches.push(a); return 0; } });
  assert.deepEqual(r, { started: true, sessionId: launches[1].sessionId, resume: true, exitCode: 0 });
  assert.equal(launches[0].resume, false);
  assert.equal(launches[1].sessionId, launches[0].sessionId);
  assert.equal(JSON.stringify(buildStatus(await readFile(ledgerPath(dir), 'utf8'))), before);
}));

test('lock: a second start while the first runs returns already_running and does not launch', withWs(async (dir) => {
  let open; const gate = new Promise((r) => { open = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  let launches = 0;
  const first = startFrontChief({ workspace: dir, rolePrompt: ROLE, launch: async () => { launches++; reached(); await gate; return 7; } });
  await reachedP;
  const second = await startFrontChief({ workspace: dir, rolePrompt: ROLE, launch: async () => { launches++; return 0; } });
  assert.deepEqual(second, { started: false, reason: 'already_running' });
  assert.equal(launches, 1);
  assert.equal(await exists(join(lockDir(dir), 'epoch-1')), true, 'the first holder keeps the lock');
  open();
  assert.deepEqual(await first, { started: true, sessionId: (await first).sessionId, resume: false, exitCode: 7 });
}));

test('renderPrompt: 3000 open tasks with long why stay within the cap and the highest issues are dropped', () => {
  const tasks = Array.from({ length: 3000 }, (_, i) => ({ issue: i + 1, state: 'queued', line: null, decision: 'd', why: `${'x'.repeat(300)}${i}`, pr: null }));
  const prompt = renderPrompt({ rolePrompt: ROLE, status: { openTasks: tasks, closedCount: 0, invalidLines: 0 } });
  assert.ok(Math.ceil(prompt.length / 4) <= PROMPT_CAP_TOKENS);
  assert.match(prompt, /^- #1 \[queued\]/m);
  const omitted = /\.\.\. (\d+) more open tasks omitted; run the status command for the full list/.exec(prompt);
  assert.ok(omitted, 'the omission line is present');
  const shown = prompt.match(/^- #\d+ /gm).length;
  assert.equal(shown + Number(omitted[1]), 3000);
  assert.ok(prompt.includes(`- #${shown} `) && !prompt.includes(`- #${shown + 1} `));
  assert.ok(prompt.includes(ROLE));
});

test('renderPrompt: a role prompt alone over the cap throws RangeError', () => {
  assert.throws(() => renderPrompt({ rolePrompt: 'x'.repeat(PROMPT_CAP_TOKENS * 4), status: { openTasks: [], closedCount: 0, invalidLines: 0 } }), RangeError);
});

test('reads: startFrontChief reads only the ledger, the session record and the role prompt; the prompt has no logs or diffs', withWs(async (dir) => {
  await seedLedger(dir, Array.from({ length: 3000 }, (_, i) => rec({ issue: i + 1, state: 'working', why: 'y'.repeat(200) })).join('\n') + '\n');
  await mkdir(join(dir, '.roundtable', 'logs'), { recursive: true });
  await writeFile(join(dir, '.roundtable', 'logs', 'run.log'), 'SECRET-LOG-LINE');
  await writeFile(join(dir, 'change.diff'), 'diff --git a/x b/x');
  const reads = [];
  const spy = (path, enc) => { reads.push(path); return readFile(path, enc); };
  let prompt;
  await startFrontChief({ workspace: dir, rolePrompt: ROLE, readFile: spy, launch: async (a) => { prompt = a.prompt; return 0; } });
  assert.deepEqual(reads, [ledgerPath(dir), sessionPath(dir)]);
  assert.ok(Math.ceil(prompt.length / 4) <= PROMPT_CAP_TOKENS);
  assert.ok(!prompt.includes('SECRET-LOG-LINE') && !prompt.includes('diff --git'));
  assert.ok(prompt.includes(ROLE));
}));

test('writes: a start writes only the session record and the ledger under .roundtable; no memory copy', withWs(async (dir) => {
  await seedLedger(dir, rec({ issue: 1, state: 'queued' }) + '\n');
  await startFrontChief({ workspace: dir, rolePrompt: ROLE, launch: async () => 0 });
  const files = (await readdir(join(dir, '.roundtable'), { recursive: true })).filter((f) => f !== 'lock-domain' && f !== 'state');
  assert.deepEqual(files.sort(), ['state/front-chief-session.json', 'state/task-ledger.jsonl']);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(sessionPath(dir), 'utf8'))).sort(), ['lastStartedAt', 'sessionId']);
  assert.equal(await exists(join(dir, '.roundtable', 'memory')), false);
}));

test('renewal: the lease is renewed every ttl/3 while launch runs, and released afterwards', withWs(async (dir) => {
  const epochFile = async () => JSON.parse(await readFile(join(lockDir(dir), 'epoch-1'), 'utf8'));
  let before;
  await startFrontChief({ workspace: dir, rolePrompt: ROLE, ttlMs: 150, launch: async () => {
    before = (await epochFile()).expiresAt;
    await sleep(200);
    return 0;
  } });
  const after = await epochFile();
  assert.ok(after.expiresAt > before, 'the lease was extended while launch ran');
  assert.equal(after.released, true);
}));

test('cli: status prints the status JSON and writes nothing', withWs(async (dir) => {
  const text = rec({ issue: 2, state: 'review', why: 'r' }) + '\n';
  await seedLedger(dir, text);
  const out = collector();
  assert.equal(await main(['status', '--workspace', dir], { stdout: out, stderr: collector() }), 0);
  assert.deepEqual(JSON.parse(out.out.join('')), buildStatus(text));
  assert.equal(await exists(join(dir, '.roundtable', 'lock-domain')), false);
}));

test('cli: start without RT_AGENT_BIN exits 2 and names the variable', withWs(async (dir) => {
  const err = collector();
  const code = await main(['start', '--workspace', dir], { env: {}, stderr: err, stdout: collector() });
  assert.equal(code, 2);
  assert.match(err.out.join(''), /no launcher configured: set RT_AGENT_BIN/);
}));

test('cli: start while a session runs exits 3', withWs(async (dir) => {
  let open; const gate = new Promise((r) => { open = r; });
  let reached; const reachedP = new Promise((r) => { reached = r; });
  const first = startFrontChief({ workspace: dir, rolePrompt: ROLE, launch: async () => { reached(); await gate; return 0; } });
  await reachedP;
  const err = collector();
  assert.equal(await main(['start', '--workspace', dir], { launch: async () => 0, stderr: err, stdout: collector() }), 3);
  open();
  await first;
}));

test('cli: start runs RT_AGENT_BIN with the contract args, the workspace as cwd, and the prompt on stdin', withWs(async (dir) => {
  const bin = join(dir, 'agent.mjs');
  const outFile = join(dir, 'out.json');
  await writeFile(bin, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => writeFileSync(process.env.RT_OUT, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), input })));
`);
  await chmod(bin, 0o755);
  const roleFile = join(dir, 'role.md');
  await writeFile(roleFile, ROLE);
  const code = await main(['start', '--workspace', dir, '--role-prompt', roleFile], { env: { RT_AGENT_BIN: bin, RT_OUT: outFile }, stderr: collector(), stdout: collector() });
  assert.equal(code, 0);
  const got = JSON.parse(await readFile(outFile, 'utf8'));
  const { sessionId } = JSON.parse(await readFile(sessionPath(dir), 'utf8'));
  assert.deepEqual(got.argv, ['chief', '--front', '--session', sessionId, '--new']);
  assert.equal(got.cwd, realpathSync(dir));
  assert.ok(got.input.includes(ROLE));
}));
