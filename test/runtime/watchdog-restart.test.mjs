import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watchdog } from '../../scripts/rtd-watchdog.mjs';
import { HEARTBEAT_PATH } from '../../runtime/supervisor/heartbeat.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { openInterventions } from '../../runtime/lib/interventions.mjs';
import { runQueue } from './observation-fixture.mjs';
import { createWorktreeManager } from '../../runtime/lib/worktree.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WATCHDOG = join(ROOT, 'scripts/rtd-watchdog.mjs');
const WALL = Date.parse('2026-11-15T12:00:00Z');
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const POLL = 1000;
const JOURNAL = '.roundtable/state/watchdog-restarts.jsonl';
const LEDGER = '.roundtable/state/freeze-ledger.jsonl';
// Locks live in the private anchor (RTW_STATE_DIR), never in the work root.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-watchdog-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rm(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-watchdog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
// Heartbeat as the daemon writes it; a verdict is stale when its age exceeds 3 polls.
async function beat(ws, lastCycleAt) {
  const hb = { schemaVersion: 1, writtenAt: lastCycleAt, daemon: { pid: 1, lastCycleAt, state: 'running' }, frontChief: { session: 'none', lastTurnAt: 0, state: 'gone' }, lastMaterialProgress: null };
  await mkdir(join(ws, '.roundtable/state'), { recursive: true });
  await writeFile(join(ws, HEARTBEAT_PATH), JSON.stringify(hb));
}
const sample = (wall, mono = wall - WALL, bootId = 'boot-1') => ({ wall, mono, bootId });
const lines = (ws, rel) => (existsSync(join(ws, rel)) ? readFileSync(join(ws, rel), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const recorder = () => { const calls = []; return { calls, exec: (argv) => { calls.push(argv); return 0; } }; };
const fakeWriter = (comments = []) => {
  const posted = [];
  return { posted, writer: { listComments: async () => comments, createComment: async (n, body) => { posted.push([n, body]); comments.push({ body }); } } };
};

test('stale heartbeat with --restart runs one systemctl restart, journals it and logs one liveness self entry', async (t) => {
  const ws = await workspace(t); await beat(ws, WALL - 10_000);
  const { calls, exec } = recorder();
  const r = await watchdog({ workspace: ws, pollMs: POLL, restart: true, unit: 'rtd.service', clock: () => sample(WALL), exec });
  assert.equal(r.exit, 3);
  assert.equal(r.restart, 'rtd.service');
  assert.deepEqual(calls, [['systemctl', '--user', 'restart', 'rtd.service']]);
  assert.deepEqual(lines(ws, JOURNAL).map((e) => [e.action, e.unit]), [['restart', 'rtd.service']]);
  assert.deepEqual(openInterventions(ws).entries().entries.map((e) => [e.category, e.source, e.reason]), [['liveness', 'self', 'restarted rtd.service after a stale heartbeat']]);
});

test('fresh and host-freeze verdicts run nothing even with --restart', async (t) => {
  const ws = await workspace(t);
  const { calls, exec } = recorder();
  await beat(ws, WALL - 100);
  assert.equal((await watchdog({ workspace: ws, pollMs: POLL, restart: true, unit: 'rtd.service', clock: () => sample(WALL), exec })).reason, 'fresh');
  await beat(ws, WALL - 10_000);
  await writeFile(join(ws, LEDGER), `${JSON.stringify({ start: WALL - 11_000, end: WALL - 1000, class: 'host-freeze' })}\n`);
  const frozen = await watchdog({ workspace: ws, pollMs: POLL, restart: true, unit: 'rtd.service', clock: () => sample(WALL + 1000), exec });
  assert.equal(frozen.reason, 'host-freeze');
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(ws, JOURNAL)), false);
});

test('--unit not matching the unit-name pattern exits 2 before anything is restarted', async (t) => {
  const ws = await workspace(t); await beat(ws, WALL - 10_000);
  for (const unit of ['rtd', 'rtd.target', '../rtd.service', 'rtd service.service']) {
    const r = spawnSync(process.execPath, [WATCHDOG, '--workspace', ws, '--poll-ms', String(POLL), '--restart', '--unit', unit], { encoding: 'utf8' });
    assert.equal(r.status, 2, unit);
  }
  assert.equal(existsSync(join(ws, JOURNAL)), false);
});

test('own freeze: a wall jump beyond one poll on the same boot skips the restart; a new boot id is not a freeze', async (t) => {
  const ws = await workspace(t); await beat(ws, WALL - 10_000);
  const { calls, exec } = recorder();
  const run = (s) => watchdog({ workspace: ws, pollMs: POLL, restart: true, unit: 'rtd.service', clock: () => s, exec });
  assert.equal((await run(sample(WALL, 0))).restart, 'rtd.service');
  const frozen = await run(sample(WALL + 60_000, 1000)); // wall +60 s, monotonic +1 s, same boot
  assert.equal(frozen.skipped, 'own-freeze');
  assert.equal(frozen.restart, undefined);
  assert.equal(calls.length, 1);
  assert.equal(lines(ws, JOURNAL).at(-1).action, 'skip');
  assert.equal((await run(sample(WALL + 120_000, 500, 'boot-2'))).restart, 'rtd.service'); // rebooted: monotonic reset
  assert.equal(calls.length, 2);
});

test('at most 3 restarts in a rolling hour: the 4th stale run alerts once and restarts nothing; a fresh heartbeat resets', async (t) => {
  const ws = await workspace(t);
  const { calls, exec } = recorder();
  const at = (min) => WALL + min * 60_000;
  const stale = (min) => beat(ws, at(min) - 10_000);
  const run = (min) => watchdog({ workspace: ws, pollMs: POLL, restart: true, unit: 'rtd.service', clock: () => sample(at(min), at(min) - WALL), exec });
  const alertsIn = () => openOutbox(ws).items().filter((i) => i.id.startsWith('notice:stall:watchdog:'));
  const exhausted = () => openInterventions(ws).entries().entries.filter((e) => e.reason === 'restart-exhausted');

  for (const min of [0, 1, 2]) { await stale(min); assert.equal((await run(min)).restart, 'rtd.service'); }
  assert.equal(calls.length, 3);

  await stale(3);
  assert.equal((await run(3)).restart, 'exhausted');
  await stale(4);
  assert.equal((await run(4)).restart, 'exhausted');
  assert.equal(calls.length, 3);
  assert.deepEqual(alertsIn().map((i) => i.id), [`notice:stall:watchdog:${new Date(at(0)).toISOString()}`]);
  assert.equal(exhausted().length, 1);

  await beat(ws, at(5) - 100);
  assert.equal((await run(5)).reason, 'fresh');
  await stale(6);
  assert.equal((await run(6)).restart, 'rtd.service');
  assert.equal(calls.length, 4);
});

test('the restart window rolls: restarts older than an hour no longer count', async (t) => {
  const ws = await workspace(t);
  const { calls, exec } = recorder();
  const at = (min) => WALL + min * 60_000;
  for (const min of [0, 1, 2]) {
    await beat(ws, at(min) - 10_000);
    await watchdog({ workspace: ws, pollMs: POLL, restart: true, unit: 'rtd.service', clock: () => sample(at(min), at(min) - WALL), exec });
  }
  await beat(ws, at(61) - 10_000);
  assert.equal((await watchdog({ workspace: ws, pollMs: POLL, restart: true, unit: 'rtd.service', clock: () => sample(at(61), at(61) - WALL), exec })).restart, 'rtd.service');
  assert.equal(calls.length, 4);
});

test('--alert-issue posts an outbox alert once as a marked comment; without it the alert is only enqueued', async (t) => {
  t.mock.method(Date, 'now', () => WALL);
  const ws = await workspace(t); await beat(ws, WALL - 10_000);
  t.mock.method(Date, 'now', () => WALL); // the alert day comes from Date.now() when not restarting
  const day = dayOf(WALL);
  const missing = { requireTools: ['gh'], lookup: () => false, clock: () => sample(WALL) };
  const { posted, writer } = fakeWriter();
  const quiet = await watchdog({ workspace: ws, pollMs: POLL, ...missing });
  assert.deepEqual(quiet.alerts, [`notice:tool-missing:gh:${day}`]);
  assert.deepEqual(posted, []);
  assert.equal(openOutbox(ws).pending().length, 1);

  const first = await watchdog({ workspace: ws, pollMs: POLL, alertIssue: 420, writer, ...missing });
  const second = await watchdog({ workspace: ws, pollMs: POLL, alertIssue: 420, writer, ...missing });
  assert.equal(first.exit, 4);
  assert.equal(second.exit, 4);
  assert.equal(posted.length, 1);
  assert.equal(posted[0][0], 420);
  assert.match(posted[0][1], new RegExp(`^<!-- rt:outbox notice:tool-missing:gh:${day} -->\n`));
  assert.equal(openOutbox(ws).pending().length, 0);
});

test('--require-tools with a missing tool exits 4 as tool-missing and enqueues one alert per tool per UTC day', async (t) => {
  const ws = await workspace(t);
  const lookup = (tool) => tool === 'git';
  const nextDay = dayOf(WALL + 86_400_000);
  const now = t.mock.method(Date, 'now', () => WALL);
  const run = (ms) => { now.mock.mockImplementation(() => WALL + ms); return watchdog({ workspace: ws, pollMs: POLL, requireTools: ['gh', 'git'], lookup }); };
  const r = await run(0);
  assert.equal(r.exit, 4);
  assert.equal(r.reason, 'tool-missing');
  assert.deepEqual(r.missing, ['gh']);
  assert.deepEqual((await run(60_000)).alerts, undefined);
  assert.deepEqual((await run(86_400_000)).alerts, [`notice:tool-missing:gh:${nextDay}`]);
  assert.deepEqual(openOutbox(ws).items().map((i) => i.id), [`notice:tool-missing:gh:${dayOf(WALL)}`, `notice:tool-missing:gh:${nextDay}`]);
});

test('user unit templates: placeholders only, restart policy, start limits, kill mode and timer cadence', () => {
  const read = (name) => readFileSync(new URL(`../../deploy/systemd/user/${name}`, import.meta.url), 'utf8');
  const names = ['rtd.service', 'rtd-watchdog.service', 'rtd-watchdog.timer'];
  for (const name of names) {
    const text = read(name);
    assert.doesNotMatch(text, /\/home\/|\/root\/|\/Users\/|\/tmp\//, `${name} has a host path`);
    assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, `${name} has an IPv4 literal`);
    for (const placeholder of text.match(/<[^>]*>/g) ?? []) assert.match(placeholder, /^<[a-z-]+>$/, `${name}: ${placeholder}`);
  }
  const daemon = read('rtd.service');
  const [unitSection, serviceSection] = daemon.split(/^\[Service\]$/m);
  assert.match(unitSection, /^StartLimitIntervalSec=3600$/m);
  assert.match(unitSection, /^StartLimitBurst=5$/m);
  for (const line of ['Restart=always', 'RestartSec=30', 'KillMode=control-group']) assert.match(serviceSection, new RegExp(`^${line}$`, 'm'));
  assert.match(read('rtd-watchdog.service'), /^ExecStart=.* --restart --unit rtd\.service/m);
  const timer = read('rtd-watchdog.timer');
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(timer, /^Persistent=true$/m);
});

test('restart-and-adopt: a lease left by an unclean stop is adopted after its TTL and resumes from the checkpoint with no second claim or worktree', async (t) => {
  const { mkdtemp: mk } = await import('node:fs/promises');
  const root = await mk(join(tmpdir(), 'rt-adopt-')); t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), workRoot = join(root, 'work');
  await mkdir(repo); await mkdir(workRoot);
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-b', 'main'); await writeFile(join(repo, 'file'), 'fixture'); git('add', 'file'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  const worktrees = () => spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;

  const issue = { id: '420', number: 420, state: 'OPEN', author: { login: 'owner' }, title: '[A] adopt', body: '', createdAt: '2020-01-01', labels: ['rt:running'], comments: [{ body: '<!-- rt:claim -->' }] };
  const events = [];
  const client = { addLabel: async () => events.push('label'), createComment: async () => events.push('comment'), listComments: async () => issue.comments };
  const { createIntakeProvider } = await import('../../runtime/lib/intake.mjs');
  const queue = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue] }, { includeRunning: true });
  await (await createWorktreeManager({ repoRoot: repo, workRoot })).create('420');
  const { createStateStore } = await import('../../runtime/lib/state.mjs');
  const store = await createStateStore({ workRoot, now: () => 1000 });
  await store.update('420', (s) => { s.status = 'working'; s.phase = 'testing'; s.checkpoint = { phase: 'developing', at: 1 }; s.lease = { owner: 'crashed', expiresAt: 1 }; s.heartbeatAt = 1; s.ledger.push({ id: 'claim', type: 'claimed' }); });
  const before = worktrees();

  const phases = [];
  const result = await runQueue({ workRoot, repoRoot: repo, githubClient: client, queue, now: () => 1_000_000,
    handler: async ({ phase }) => { phases.push(phase); return { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' }; } });
  assert.deepEqual(phases, ['testing', 'reviewing', 'finalizing'], 'developing is not redone');
  assert.equal(result.outcomes[0].status, 'done');
  assert.deepEqual(events, []);
  assert.equal(issue.comments.length, 1);
  assert.equal(worktrees(), before);
});

test('report-only runs never call the injected clock (no /proc reads), and keep the verdicts and exit codes', async (t) => {
  const ws = await workspace(t);
  const throwing = () => { throw new Error('clock must not be sampled without --restart'); };
  const now = Date.now();
  await beat(ws, now - 100);
  const fresh = await watchdog({ workspace: ws, pollMs: POLL, clock: throwing });
  assert.equal(fresh.reason, 'fresh');
  assert.equal(fresh.exit, 0);
  await beat(ws, now - 10_000);
  const stale = await watchdog({ workspace: ws, pollMs: POLL, clock: throwing });
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.exit, 3);
  assert.equal(stale.restart, undefined);
  assert.equal(existsSync(join(ws, JOURNAL)), false);
});
