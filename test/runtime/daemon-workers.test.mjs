import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { runQueue } from '../../runtime/rtd.mjs';
import { createWorktreeManager } from '../../runtime/lib/worktree.mjs';

const scratch = join(process.cwd(), '.roundtable/scratch/rt51-fix2/tmp');
const tmp = async () => { await mkdir(scratch, { recursive: true }); return mkdtemp(join(scratch, 'case-')); };
// Locks live in the private anchor (RTW_STATE_DIR), never in the work root.
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });
async function fixture() {
  const root = await tmp(), repo = join(root, 'repo'), workRoot = join(root, 'work');
  await mkdir(repo); await mkdir(workRoot);
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git('init', '-b', 'main'); await writeFile(join(repo, 'file'), 'fixture'); git('add', 'file'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture');
  return { root, repo, workRoot };
}
const handler = async ({ phase }) => ({ exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' });
function clientFor(issue) {
  const events = [];
  return { events, addLabel: async (_n, label) => { events.push('label'); issue.labels.push(label); }, createComment: async (_n, body) => { events.push('comment'); issue.comments.push({ body }); }, listComments: async () => issue.comments };
}
test('daemon does not claim an issue with a live worktree or held lock', async () => {
  const { root, repo, workRoot } = await fixture();
  try {
    const manager = await createWorktreeManager({ repoRoot: repo, workRoot });
    for (const id of ['12', '13']) {
      const issue = { id, number: Number(id), labels: [], comments: [] }, client = clientFor(issue);
      const lock = id === '13' ? await manager.acquire(id) : null;
      if (!lock) await manager.create(id);
      let calls = 0;
      await runQueue({ workRoot, repoRoot: repo, githubClient: client, queue: [issue], handler: async () => { calls++; return { exitCode: 0 }; } });
      assert.deepEqual(client.events, []); assert.equal(calls, 0);
      if (lock) await lock.release();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('daemon resumes stale durable working state without a second claim', async () => {
  const { root, repo, workRoot } = await fixture();
  try {
    const issue = { id: '14', number: 14, state: 'OPEN', author: { login: 'owner' }, title: '[A] resume', body: '', createdAt: '2020-01-01', labels: ['rt:running'], comments: [{ body: '<!-- rt:claim -->' }] }, client = clientFor(issue);
    const { createIntakeProvider } = await import('../../runtime/lib/intake.mjs');
    const queue = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue] }, { includeRunning: true });
    const manager = await createWorktreeManager({ repoRoot: repo, workRoot });
    await manager.create('14');
    const { createStateStore } = await import('../../runtime/lib/state.mjs');
    const store = await createStateStore({ workRoot, now: () => 1000 });
    await store.update('14', s => { s.status = 'working'; s.phase = 'testing'; s.checkpoint = { phase: 'developing', at: 1 }; s.lease = { owner: 'previous', expiresAt: 1 }; s.heartbeatAt = 1; });
    const phases = [];
    const result = await runQueue({ workRoot, repoRoot: repo, githubClient: client, queue, now: () => 1000000, handler: async ctx => { phases.push(ctx.phase); return handler(ctx); } });
    assert.deepEqual(phases, ['testing', 'reviewing', 'finalizing']);
    assert.equal(result.outcomes[0].status, 'done'); assert.deepEqual(client.events, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('daemon clears a stale ask pause and resumes after an owner reply', async () => {
  const { root, repo, workRoot } = await fixture();
  try {
    const repliedAt = '2026-01-02T00:00:00Z';
    const issue = { id: '15', number: 15, state: 'OPEN', author: { login: 'owner' }, title: '[A] paused', labels: ['rt:running', 'rt:ask'], comments: [
      { id: 1, body: '<!-- rt:ask -->\nDECISION=ask\nscope\nQuestion?', createdAt: '2026-01-01T00:00:00Z' },
      { id: 2, body: 'Proceed', author: { login: 'owner' }, createdAt: repliedAt },
    ] };
    const events = [];
    const client = {
      addLabel: async (number, label) => { events.push(['addLabel', number, label]); issue.labels.push(label); },
      removeLabel: async (number, label) => { events.push(['removeLabel', number, label]); issue.labels = issue.labels.filter(value => value !== label); },
      createComment: async (number, body) => { events.push(['createComment', number, body]); issue.comments.push({ id: 3, body }); },
      listComments: async () => issue.comments,
    };
    const store = await (await import('../../runtime/lib/state.mjs')).createStateStore({ workRoot, now: () => Date.parse(repliedAt) + 1 });
    await store.update('15', state => { state.status = 'waiting_person'; state.pause = { kind: 'ask', category: 'scope', pausedAt: Date.parse('2026-01-01T00:00:00Z'), commentId: 1, commentCreatedAt: '2026-01-01T00:00:00Z' }; state.attempts.wakes = 1; });
    const phases = [];
    const result = await runQueue({ workRoot, repoRoot: repo, githubClient: client, queue: [issue], now: () => Date.parse(repliedAt) + 1,
      handler: async ({ phase }) => { phases.push(phase); return handler({ phase }); } });
    assert.equal(result.outcomes[0].status, 'done');
    assert.deepEqual(events, [['removeLabel', 15, 'rt:ask'], ['removeLabel', 15, 'rt:blocked']]);
    assert.equal(issue.labels.includes('rt:ask'), false);
    assert.equal((await store.load('15')).pause, undefined);
    assert.deepEqual(phases, ['developing', 'testing', 'reviewing', 'finalizing']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('daemon claims and schedules bounded, non-conflicting workers with visible worktrees', async () => {
  const { root, repo, workRoot } = await fixture();
  try {
    const issues = [
      { id: '21', number: 21, title: '[A] first', labels: [], comments: [] },
      { id: '22', number: 22, title: '[A] second', labels: [], comments: [] },
      { id: '23', number: 23, title: '[B] dependent', body: 'Depends on #21', labels: [], comments: [] },
      { id: '24', number: 24, title: '[C] independent', labels: [], comments: [] },
    ];
    const events = [];
    const client = {
      addLabel: async (n, label) => { events.push(['label', n]); issues.find(i => i.number === n).labels.push(label); },
      createComment: async (n, body) => { events.push(['comment', n]); issues.find(i => i.number === n).comments.push({ body }); },
      listComments: async n => issues.find(i => i.number === n).comments,
    };
    const observer = await createWorktreeManager({ repoRoot: repo, workRoot });
    const active = new Set(); let peak = 0;
    let releasePair; const pair = new Promise(resolve => { releasePair = resolve; });
    const result = await runQueue({ workRoot, repoRoot: repo, githubClient: client, queue: issues, workers: 2,
      handler: async ({ item, phase }) => {
        if (phase === 'developing') {
          assert.equal((await observer.inspect(item.id)).liveWorktree, true);
          assert.equal((await observer.inspect(item.id)).heldLock, true);
          if (item.id === '21') { assert.equal(active.has('22'), false); assert.equal(active.has('23'), false); }
          if (item.id === '22' || item.id === '23') assert.equal(active.has('21'), false);
          active.add(item.id); peak = Math.max(peak, active.size);
          if (active.has('21') && active.has('24')) releasePair();
          if (item.id === '21' || item.id === '24') {
            let timer;
            try { await Promise.race([pair, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('workers did not overlap')), 5000); })]); }
            finally { clearTimeout(timer); }
          }
          active.delete(item.id);
        }
        return handler({ phase });
      },
    });
    assert.equal(peak, 2); assert.equal(result.outcomes.length, 4);
    assert.ok(result.outcomes.every(o => o.status === 'done'));
    assert.equal(events.filter(([type]) => type === 'comment').length, 4);
    await runQueue({ workRoot, repoRoot: repo, githubClient: client, queue: issues, handler });
    assert.equal(events.filter(([type]) => type === 'comment').length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tracker intake includes stale running issues for durable recovery', async () => {
  const { createIntakeProvider } = await import('../../runtime/lib/intake.mjs');
  const issue = { number: 31, state: 'OPEN', author: { login: 'owner' }, title: '[A] resume', body: 'Depends on #32', labels: ['rt:running'], createdAt: '2020-01-01' };
  const provider = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => [issue], getIssue: async () => ({ state: 'OPEN' }) }, { includeRunning: true });
  const items = await provider();
  assert.equal(items.length, 1); assert.deepEqual(items[0].labels, ['rt:running']); assert.equal(items[0].body, issue.body);
});

test('tracker writer exposes only claim-related operations and selects the repository', async () => {
  const { createGitHubWriter } = await import('../../scripts/github-read.mjs');
  const calls = [];
  const writer = createGitHubWriter({ repo: 'owner/repo', run: async args => { calls.push(args); return '{"comments":[]}'; } });
  await writer.addLabel(31, 'rt:running'); await writer.createComment(31, '<!-- rt:claim -->'); await writer.listComments(31); await writer.removeLabel(31, 'rt:running');
  assert.deepEqual(calls.map(args => args.slice(0, 2)), [['issue', 'edit'], ['issue', 'comment'], ['issue', 'view'], ['issue', 'edit']]);
  assert.ok(calls.every(args => args.includes('owner/repo')));
  assert.throws(() => writer.addLabel('../31', 'rt:running'), /Invalid issue number/);
});

test('running label without durable state does not start an unknown orphan', async () => {
  const { root, repo, workRoot } = await fixture();
  try {
    const issue = { id: '41', number: 41, labels: ['rt:running'], comments: [] }, client = clientFor(issue);
    let calls = 0;
    await runQueue({ workRoot, repoRoot: repo, githubClient: client, queue: [issue], handler: async () => { calls++; return { exitCode: 0 }; } });
    assert.equal(calls, 0); assert.deepEqual(client.events, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('daemon finishes a claim interrupted after adding the label', async () => {
  const { root, repo, workRoot } = await fixture();
  try {
    const issue = { id: '42', number: 42, labels: [], comments: [] }, client = clientFor(issue);
    const create = client.createComment; let interrupted = true;
    client.createComment = async (...args) => { if (interrupted) { interrupted = false; throw new Error('interrupted'); } return create(...args); };
    await assert.rejects(runQueue({ workRoot, repoRoot: repo, githubClient: client, queue: [issue], handler }), /interrupted/);
    const result = await runQueue({ workRoot, repoRoot: repo, githubClient: client, queue: [issue], handler });
    assert.equal(result.outcomes[0].status, 'done'); assert.equal(issue.comments.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
