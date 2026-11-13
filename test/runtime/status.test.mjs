import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectStatus, formatStatus } from '../../runtime/lib/status.mjs';

test('status keeps one field set in text and JSON and remains read-only across calls', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt-status-'));
  try {
    const stateDir = join(root, 'state');
    const rtDir = join(root, '.roundtable', 'state');
    const before = JSON.stringify({ root: 'synthetic' });
    await Promise.all([mkdir(stateDir), mkdir(rtDir, { recursive: true })]);
    const statePath = join(stateDir, '41.json');
    const initialState = JSON.stringify({ id: '41', status: 'working', phase: 'reviewing', heartbeatAt: 1794556800000,
      attempts: { developer: 1, reviewerUnavailable: 2, wakes: 3 }, lease: { owner: 'worker', expiresAt: 1794556860000 },
      gateRecord: { passed: ['gate0', 'gate1'], head: 'abc', tree: 'tree' }, lastEvent: { type: 'waiting_external', at: 1794556800000, detail: 'CI pending' } });
    await writeFile(statePath, initialState);
    await writeFile(join(rtDir, 'merges.log'), `${JSON.stringify({ issue: 39, pr: 12, at: 1794556700000 })}\n`);
    const initialMerges = await readFile(join(rtDir, 'merges.log'), 'utf8');
    const writes = [];
    const githubReader = {
      async listIssues() { return [{ number: 41, title: 'Synthetic task', labels: ['rt:running'], state: 'OPEN', updatedAt: '2026-11-13T00:00:00Z' }]; },
      async addLabel() { writes.push('addLabel'); },
    };
    const sources = {
      async github() { const issues = await githubReader.listIssues(); return { issues, queue: ['41'], quotaWait: null }; },
    };
    const first = await collectStatus({ workRoot: root, sources, now: () => 1794556800000 });
    const second = await collectStatus({ workRoot: root, sources, now: () => 1794556800000 });
    const json = JSON.parse(JSON.stringify(first));
    const text = formatStatus(second);
    assert.deepEqual(Object.keys(first), Object.keys(second));
    for (const key of Object.keys(json)) assert.match(text, new RegExp(key));
    assert.equal(first.generatedAt, '2026-11-13T08:00:00.000Z');
    assert.equal(first.active.issue, '41');
    assert.equal(first.issues[0].stage, 'reviewing');
    assert.equal(first.issues[0].gates.review.result, 'passed');
    assert.equal(first.quotaWait, null);
    assert.equal(first.local.available, true);
    assert.equal(first.remote.status, 'refreshed');
    assert.equal(first.local.status, 'available');
    assert.match(first.generatedAt, /Z$/);
    assert.equal(await readFile(statePath, 'utf8'), initialState);
    assert.equal(await readFile(join(rtDir, 'merges.log'), 'utf8'), initialMerges);
    assert.deepEqual(writes, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('status preserves local details when GitHub fails and preserves GitHub details when local state is missing', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt-status-partial-'));
  try {
    await mkdir(join(root, 'state'));
    const remoteFailure = await collectStatus({ workRoot: root, sources: { async github() { throw new Error('offline'); } }, now: () => 0 });
    assert.equal(remoteFailure.remote.refreshed, false);
    assert.equal(remoteFailure.remote.status, 'not refreshed');
    assert.equal(remoteFailure.remote.error, 'snapshot source could not be read');
    assert.equal(remoteFailure.local.available, true);
    assert.deepEqual(remoteFailure.queue, { count: null, issueIds: null });
    const localFailure = await collectStatus({ workRoot: join(root, 'missing'), sources: { async github() { return { issues: [{ number: 7, title: 'Synthetic', labels: [], state: 'OPEN' }], queue: ['7'] }; }, async local() { throw new Error('missing snapshot'); } }, now: () => 0 });
    assert.equal(localFailure.remote.refreshed, true);
    assert.equal(localFailure.local.available, false);
    assert.equal(localFailure.local.status, 'no local snapshot');
    assert.equal(localFailure.issues[0].id, '7');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime entry exposes status text and JSON from synthetic read-only providers', async (t) => {
  const root = await mkdtemp(join(process.cwd(), 'rt-status-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = join(root, 'providers.mjs');
  await writeFile(provider, `export default {
    async github() { return { issues: [{number: 8, title: 'Synthetic issue', labels: [], state: 'OPEN'}], queue: ['8'] }; },
    async local() { return { issues: [], recentMerges: [] }; }
  };\n`);
  const cli = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
  const run = (args) => spawnSync(process.execPath, [cli, 'status', '--work-root', root, '--providers', provider, ...args], { cwd: root, encoding: 'utf8' });
  const text = run([]);
  const json = run(['--json']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(json.status, 0, json.stderr);
  const snapshot = JSON.parse(json.stdout);
  for (const key of Object.keys(snapshot)) assert.match(text.stdout, new RegExp(`^${key}:`, 'm'));
  assert.equal(snapshot.issues[0].id, '8');
  assert.equal(snapshot.active.idle, true);
});

test('status selects the highest epoch by filename and retains legacy states', async (t) => {
  const root = await mkdtemp(join(process.cwd(), 'rt-status-epoch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state'));
  for (const [name, state] of Object.entries({
    '41.json': { id: '41', status: 'queued' },
    '~3431.epoch-2.json': { id: '41', status: 'queued' },
    '~3431.epoch-10.json': { id: 'wrong', status: 'working' },
    '42.json': { id: '42', status: 'blocked' },
  })) await writeFile(join(root, 'state', name), JSON.stringify(state));
  const snapshot = await collectStatus({ workRoot: root, sources: { github: async () => { throw Error('offline'); } } });
  assert.equal(snapshot.issues.find((issue) => issue.id === '41').status, 'working');
  assert.equal(snapshot.issues.find((issue) => issue.id === '42').status, 'blocked');
  assert.equal(snapshot.issues.length, 2);
  assert.deepEqual(snapshot.queue, { count: null, issueIds: null });
  assert.equal(snapshot.active.idle, false);
});

test('missing remote queue and active state remain unknown', async () => {
  const snapshot = await collectStatus({ sources: { github: async () => { throw Error('offline'); }, local: async () => ({ issues: [] }) } });
  assert.deepEqual(snapshot.queue, { count: null, issueIds: null });
  assert.equal(snapshot.active.idle, null);
});

test('status exposes only safe gate and waiting summaries and derives per-issue budgets', async () => {
  const snapshot = await collectStatus({ budgets: { maxWakesPerIssue: 5, maxDeveloperAttempts: 3 }, sources: {
    github: async () => ({ issues: [], queue: [] }),
    local: async () => ({ issues: [{ id: '9', status: 'waiting_external', attempts: { wakes: 2, developer: 1 },
      gateRecord: { passed: ['gate0'], gate1: { result: 'blocked', scope: 'issue', blockReason: 'review required', log: 'SECRET_GATE_LOG' } },
      lastEvent: { type: 'finalize_hold', at: 0, detail: 'SECRET_PRIVATE_COMMENT\nSECRET_DIFF' } }] }),
  } });
  const issue = snapshot.issues[0];
  assert.deepEqual(issue.gates.gate, { result: 'passed', scope: null, blockReason: null });
  assert.equal(issue.gates.review, null);
  assert.deepEqual(issue.budgets.wakes, { used: 2, remaining: 3 });
  assert.deepEqual(issue.budgets.reviewerUnavailable, { used: null, remaining: null });
  assert.equal(issue.waiting.type, 'finalize_hold');
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET_/);
});

test('GitHub read client requests issue updatedAt', async () => {
  const { createGitHubReader } = await import('../../scripts/github-read.mjs');
  let fields;
  const reader = createGitHubReader({ run: async (args) => { fields = args[args.indexOf('--json') + 1]; return []; } });
  await reader.listIssues();
  assert.ok(fields.split(',').includes('updatedAt'));
});

test('production status CLI reports runtime budgets, concurrent activity, liveness and pause data without mutations', async (t) => {
  const root = await mkdtemp(join(process.cwd(), 'rt-status-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state'));
  const now = Date.now();
  await writeFile(join(root, 'state', '1.json'), JSON.stringify({ status: 'working', heartbeatAt: now, attempts: { wakes: 2, developer: 1, reviewerUnavailable: 0 }, gateRecord: { passed: ['gate0'] } }));
  await writeFile(join(root, 'state', '2.json'), JSON.stringify({ status: 'working', heartbeatAt: now - 130000 }));
  await writeFile(join(root, 'state', '3.json'), JSON.stringify({ status: 'waiting_person', pause: { kind: 'ask', category: 'credentials', pausedAt: now }, lastEvent: { type: 'decision_ask', at: now, detail: 'SECRET' } }));
  const provider = join(root, 'providers.mjs');
  await writeFile(provider, `export default { async github() { return { issues: [{number:1,labels:['rt:running']},{number:2,labels:['rt:running']},{number:3,labels:['rt:ask']}], queue: [] }; } };`);
  const { readdir } = await import('node:fs/promises');
  async function tree(dir, prefix = '') { const out = {}; for (const entry of await readdir(dir, { withFileTypes: true })) { const name = join(prefix, entry.name); if (entry.isDirectory()) Object.assign(out, await tree(join(dir, entry.name), name)); else out[name] = await readFile(join(dir, entry.name), 'utf8'); } return out; }
  const before = await tree(root);
  const cli = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
  const run = (args) => spawnSync(process.execPath, [cli, 'status', '--work-root', root, '--providers', provider, ...args], { cwd: root, encoding: 'utf8' });
  const json = run(['--json']); const text = run([]); const again = run(['--json']);
  assert.equal(json.status, 0, json.stderr); assert.equal(text.status, 0, text.stderr); assert.equal(again.status, 0, again.stderr);
  const snapshot = JSON.parse(json.stdout);
  assert.deepEqual(snapshot.active.issueIds, ['1', '2']);
  assert.deepEqual(snapshot.issues[0].budgets.wakes, { used: 2, remaining: 3 });
  assert.equal(snapshot.issues[0].heartbeatLive, true);
  assert.equal(snapshot.issues[1].heartbeatLive, false);
  assert.equal(snapshot.issues[2].waiting.waitingOn, 'owner');
  assert.equal(snapshot.issues[2].waiting.conclusion, 'credentials');
  assert.equal(snapshot.blockerCount, 1);
  assert.doesNotMatch(json.stdout, /SECRET/);
  for (const [key, value] of Object.entries(snapshot)) if (key !== 'generatedAt') assert.deepEqual(JSON.parse(text.stdout.split('\n').find(line => line.startsWith(`${key}: `)).slice(key.length + 2)), value);
  assert.deepEqual(await tree(root), before);
});

test('corrupt newest state does not claim a complete idle snapshot', async (t) => {
  const root = await mkdtemp(join(process.cwd(), 'rt-status-corrupt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state'));
  await writeFile(join(root, 'state', '1.json'), JSON.stringify({ status: 'working' }));
  await writeFile(join(root, 'state', '~31.epoch-2.json'), '{');
  await writeFile(join(root, 'state', '2.json'), JSON.stringify({ status: 'blocked' }));
  const snapshot = await collectStatus({ workRoot: root, sources: { github: async () => ({ issues: [], queue: [] }) } });
  assert.equal(snapshot.local.complete, false);
  assert.equal(snapshot.active.idle, null);
  assert.equal(snapshot.issues.find(i => i.id === '2').status, 'blocked');
});

test('gate summaries ignore fields that the runtime never persists', async () => {
  const snapshot = await collectStatus({ sources: { github: async () => ({ issues: [], queue: [] }), local: async () => ({ issues: [{ id: '1', gateRecord: { passed: ['gate0'], gate1: { result: 'blocked', scope: 'invented', blockReason: 'private' } }, lastEvent: { type: 'finalize_hold', detail: 'gate1: private reason' }, status: 'waiting_external' }] }) } });
  assert.deepEqual(snapshot.issues[0].gates.gate, { result: 'passed', scope: null, blockReason: null });
  assert.deepEqual(snapshot.issues[0].gates.review, { result: 'waiting', scope: null, blockReason: null });
  assert.doesNotMatch(JSON.stringify(snapshot), /private|invented/);
});

test('production GitHub reader separates intake queue and reports dependency failures as unknown', async (t) => {
  const { chmod, readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.cwd(), 'rt-status-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state')); await mkdir(join(root, 'bin'));
  const gh = join(root, 'bin', 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'repo' && args[1] === 'view') console.log(JSON.stringify({owner:{login:'owner'},name:'repo'}));
else if (args[0] === 'issue' && args[1] === 'list') console.log(JSON.stringify([
 {number:1,title:'Pending',state:'OPEN',author:{login:'owner'},labels:['type:bug'],body:'',createdAt:'2026-01-01'},
 {number:2,title:'Running',state:'OPEN',author:{login:'owner'},labels:['rt:running'],body:'',createdAt:'2026-01-02'},
 {number:3,title:'Waiting',state:'OPEN',author:{login:'owner'},labels:['rt:ask'],body:'',createdAt:'2026-01-03'},
 {number:4,title:'Dependency',state:'OPEN',author:{login:'owner'},labels:['type:bug'],body:'Depends on #99',createdAt:'2026-01-04'}]));
else if (args[0] === 'issue' && args[1] === 'view' && args[2] === '99') { if (process.env.TEST_DEP_FAIL === '1') process.exit(1); console.log(JSON.stringify({state:'CLOSED'})); }
else process.exit(88);
`); await chmod(gh, 0o755);
  async function tree(dir, prefix = '') { const out = {}; for (const entry of await readdir(dir, { withFileTypes: true })) { const name = join(prefix, entry.name); if (entry.isDirectory()) Object.assign(out, await tree(join(dir, entry.name), name)); else out[name] = await readFile(join(dir, entry.name), 'utf8'); } return out; }
  const before = await tree(root);
  const cli = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
  const run = (fail) => spawnSync(process.execPath, [cli, 'status', '--json', '--work-root', root], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TEST_DEP_FAIL: fail ? '1' : '0' } });
  const good = run(false); const partial = run(true); const repeated = run(false);
  for (const result of [good, partial, repeated]) assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(good.stdout).queue.issueIds, ['1', '4']);
  assert.deepEqual(JSON.parse(good.stdout).active.issueIds, ['2']);
  assert.equal(JSON.parse(good.stdout).blockerCount, 1);
  assert.deepEqual(JSON.parse(partial.stdout).queue, { count: null, issueIds: null });
  assert.deepEqual(await tree(root), before);
});

test('malformed runtime fields and timestamps leave an incomplete snapshot without losing valid issues', async (t) => {
  const root = await mkdtemp(join(process.cwd(), 'rt-status-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state'));
  await writeFile(join(root, 'state', '1.json'), JSON.stringify({ status: 'working', attempts: 'bad' }));
  await writeFile(join(root, 'state', '2.json'), JSON.stringify({ status: 'waiting_person', lastEvent: { type: 'waiting_person', at: 'bad' } }));
  await writeFile(join(root, 'state', '3.json'), JSON.stringify({ status: 'blocked' }));
  const snapshot = await collectStatus({ workRoot: root, sources: { github: async () => ({ issues: [], queue: [] }) } });
  assert.equal(snapshot.local.complete, false);
  assert.equal(snapshot.issues.find(i => i.id === '3').status, 'blocked');
  assert.equal(snapshot.issues.find(i => i.id === '2').waiting.since, null);
  assert.equal(snapshot.blockerCount, null);
});

test('GitHub reader uses only guarded gh pr list reads and returns reduced linked pull requests', async () => {
  const { createGitHubReader } = await import('../../scripts/github-read.mjs');
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.includes('merged')) return [{ number: 7, title: 'Merged', mergedAt: '2026-01-01T00:00:00Z', headRefName: 'feature', baseRefName: 'main' }];
    return [
      { number: 8, title: 'Linked', body: 'Closes #1\nSECRET_PR_BODY', state: 'OPEN' },
      { number: 9, title: 'Also linked', body: 'Fixes owner/repo#2 and resolves other/repo#3', state: 'MERGED' },
      { number: 10, title: 'Unlinked', body: 'No closing keyword here', state: 'OPEN' },
    ];
  };
  const reader = createGitHubReader({ repo: 'owner/repo', run });
  const linked = await reader.listLinkedPullRequests({ owner: 'owner', name: 'repo' });
  const merges = await reader.listRecentMerges();
  assert.deepEqual(linked, { 1: [{ number: 8, title: 'Linked' }], 2: [{ number: 9, title: 'Also linked' }] });
  assert.deepEqual(merges, [{ number: 7, title: 'Merged', mergedAt: '2026-01-01T00:00:00Z', headRefName: 'feature', baseRefName: 'main' }]);
  assert.equal(calls.length, 2);
  for (const args of calls) {
    assert.deepEqual(args.slice(0, 2), ['pr', 'list']);
    assert.ok(!args.includes('api'));
    assert.equal(args[args.indexOf('--repo') + 1], 'owner/repo');
  }
  for (const args of calls.filter((value) => !value.includes('merged'))) {
    assert.deepEqual(args.slice(args.indexOf('--state'), args.indexOf('--state') + 2), ['--state', 'all']);
  }
  const mergedCall = calls.find((value) => value.includes('merged'));
  assert.deepEqual(mergedCall.slice(mergedCall.indexOf('--state'), mergedCall.indexOf('--state') + 2), ['--state', 'merged']);
  assert.doesNotMatch(JSON.stringify(linked), /SECRET_PR_BODY|No closing keyword/);
});

test('GitHub reader separates empty linked pull results from failures', async () => {
  const { createGitHubReader } = await import('../../scripts/github-read.mjs');
  const empty = createGitHubReader({ run: async () => [] });
  assert.deepEqual(await empty.listLinkedPullRequests({ owner: 'owner', name: 'repo' }), {});
  assert.deepEqual(await empty.listRecentMerges(), []);
  const failing = createGitHubReader({ run: async () => { throw new Error('gh failed'); } });
  await assert.rejects(failing.listLinkedPullRequests({ owner: 'owner', name: 'repo' }));
  await assert.rejects(failing.listRecentMerges());
  const malformed = createGitHubReader({ run: async () => [{ number: 'x', title: 'Bad', body: '' }] });
  await assert.rejects(malformed.listLinkedPullRequests({ owner: 'owner', name: 'repo' }), TypeError);
  const truncated = createGitHubReader({ run: async () => Array.from({ length: 1000 }, (_, index) => ({ number: index + 1, title: 'Many', body: '' })) });
  await assert.rejects(truncated.listLinkedPullRequests({ owner: 'owner', name: 'repo' }), TypeError);
});

test('production status reads linked PRs and recent merges and distinguishes empty from unavailable', async (t) => {
  const { chmod, readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(process.cwd(), 'rt-status-gh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'state')); await mkdir(join(root, 'bin'));
  const gh = join(root, 'bin', 'gh');
  await writeFile(gh, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'repo' && a[1] === 'view') console.log(JSON.stringify({owner:{login:'owner'},name:'repo'}));
else if (a[0] === 'issue' && a[1] === 'list') console.log(JSON.stringify([{number:1,title:'Task',state:'OPEN',author:{login:'owner'},labels:[],body:'',createdAt:'2026-01-01'}]));
else if (a[0] === 'pr' && a[1] === 'list' && a.includes('merged')) { if (process.env.MODE === 'fail') process.exit(1); console.log(JSON.stringify(process.env.MODE === 'empty' ? [] : [{number:7,title:'Merged',mergedAt:'2026-01-01T00:00:00Z',headRefName:'feature',baseRefName:'main'}])); }
else if (a[0] === 'pr' && a[1] === 'list' && a.includes('--repo') && a[a.indexOf('--repo') + 1] === 'owner/repo') { if (process.env.MODE === 'fail') process.exit(1); console.log(JSON.stringify(process.env.MODE === 'empty' ? [] : [{number:8,title:'Linked',body:'Closes #1\\n\\nSECRET_PR_BODY',state:'OPEN'}])); }
else process.exit(86);
`); await chmod(gh, 0o755);
  async function tree(dir, prefix = '') { const out = {}; for (const e of await readdir(dir, { withFileTypes: true })) { const n = join(prefix, e.name); if (e.isDirectory()) Object.assign(out, await tree(join(dir, e.name), n)); else out[n] = await readFile(join(dir, e.name), 'utf8'); } return out; }
  const before = await tree(root);
  const cli = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
  const run = (mode, json = true) => spawnSync(process.execPath, [cli, 'status', '--work-root', root, ...(json ? ['--json'] : [])], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}`, MODE: mode } });
  const good = run('good'), empty = run('empty'), fail = run('fail'), text = run('good', false), repeat = run('good');
  for (const r of [good, empty, fail, text, repeat]) assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(good.stdout), b = JSON.parse(empty.stdout), c = JSON.parse(fail.stdout);
  assert.equal(a.recentMerges[0].number, 7);
  assert.deepEqual(a.issues[0].pr, [{ number: 8, title: 'Linked' }]);
  assert.deepEqual(b.recentMerges, []); assert.deepEqual(b.issues[0].pr, []);
  assert.equal(c.recentMerges, null); assert.equal(c.issues[0].pr, null);
  for (const [key, value] of Object.entries(a)) if (key !== 'generatedAt') assert.deepEqual(JSON.parse(text.stdout.split('\n').find(line => line.startsWith(`${key}: `)).slice(key.length + 2)), value);
  assert.doesNotMatch(good.stdout, /SECRET_PR_BODY|Closes #1/);
  assert.doesNotMatch(text.stdout, /SECRET_PR_BODY|Closes #1/);
  for (const forbidden of [['api', 'graphql'], ['api', 'rest'], ['issue', 'edit', '1'], ['pr', 'merge', '1'], ['issue', 'comment', '1'], ['issue', 'close', '1']]) assert.equal(spawnSync(gh, forbidden, { encoding: 'utf8' }).status, 86);
  assert.deepEqual(await tree(root), before);
});
