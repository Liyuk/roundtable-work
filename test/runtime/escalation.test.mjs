import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStateStore } from '../../runtime/lib/state.mjs';
import { runQueue } from './observation-fixture.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
const ANCHOR = await mkdtemp(join(tmpdir(), 'rt-escalation-anchor-'));
process.env.RTW_STATE_DIR = ANCHOR;
process.on('exit', () => { try { rmSync(ANCHOR, { recursive: true, force: true }); } catch { /* best effort */ } });

async function fixture(fn) {
  const scratch = join(ROOT, '.roundtable/scratch/98-dev-01');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'runtime-case-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const question = { decision: 'ask', category: 'scope', question: 'Expand scope?' };

test('daemon retries a persisted disputed decision on a later invocation', async () => fixture(async root => {
  const workTypes = [];
  const handler = async ({ phase, state }) => phase === 'finalizing'
    ? { exitCode: 0, ...(state.pendingDecision ? { decision: { decision: 'ask', category: 'direction', question: 'Changed output' } } : { decision: question }) }
    : { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' };
  const modelRouter = type => { workTypes.push(type); return 'configured-escalation-model'; };
  const failed = await runQueue({ workRoot: root, queue: ['70'], handler, modelRouter,
    escalationAdapter: async () => { throw new Error('temporarily unavailable'); } });
  assert.equal(failed.outcomes[0].status, 'waiting_external');
  assert.deepEqual((await createStateStore({ workRoot: root }).then(store => store.load('70'))).pendingDecision,
    { decision: question, attempts: 1 });

  const retried = await runQueue({ workRoot: root, queue: ['70'], handler, modelRouter,
    escalationAdapter: async ({ decision, attempt }) => {
      assert.deepEqual(decision, question); assert.equal(attempt, 2);
      return { decision: 'do', reason: 'Resolved.' };
    } });
  assert.equal(retried.outcomes[0].status, 'queued', JSON.stringify(retried.outcomes[0]));
  assert.equal((await createStateStore({ workRoot: root }).then(store => store.load('70'))).pendingDecision, undefined);
  assert.deepEqual(workTypes, ['development', 'verification', 'review', 'chief', 'escalation', 'chief', 'escalation']);
}));

test('CLI passes the validated escalation route and injected adapter to runtime without live calls', async () => fixture(async root => {
  await writeFile(join(root, 'queue.json'), JSON.stringify([{ id: '71' }]));
  const role = (model, tier) => ({ harness: 'pi', model, tier });
  await writeFile(join(root, 'routing.json'), JSON.stringify({ version: 1, windows: [{
    id: 'test', from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z',
    roles: { chief: role('provider/standard', 'standard'), developer: role('provider/standard', 'standard'), fixer: role('provider/standard', 'standard'),
      reviewer: role('provider/reviewer', 'strong'), researcher: role('provider/standard', 'standard'), crosscheck: role('provider/audit', 'strong') },
  }] }));
  await writeFile(join(root, 'handler.mjs'), `
import { writeFileSync } from 'node:fs';
export const observationClients = {
  expectedSha: () => 'a'.repeat(40),
  issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
  worktree: { async inspect() { return { dirty: false }; } },
  git: { async head() { return 'a'.repeat(40); }, async commit() { return { sha: 'a'.repeat(40) }; } },
  evidence: { async checks() { return { sha: 'a'.repeat(40), conclusion: 'success' }; }, async review() { return { sha: 'a'.repeat(40), conclusion: 'approved' }; } },
};
export const escalationAdapter = async ({ decision, model, attempt }) => {
  writeFileSync(process.env.RT_TEST_RESULT, JSON.stringify({ decision, model, attempt }));
  return { decision: 'do', reason: 'Resolved by the injected adapter.' };
};
export default async ({ phase }) => phase === 'finalizing'
  ? { exitCode: 0, decision: ${JSON.stringify(question)} }
  : { exitCode: 0, output: phase === 'reviewing' ? '审查结论：通过' : 'ok' };
`);
  const resultPath = join(root, 'adapter-result.json');
  const env = { ...process.env, RT_TEST_RESULT: resultPath,
    RT_MODEL: 'provider/standard', RT_REVIEWER_MODEL: 'provider/reviewer',
    RT_DECIDER_MODEL: 'provider/escalation', RT_CROSSCHECK_MODEL: 'provider/audit',
    RT_ALLOWED_MODELS: 'provider/standard,provider/reviewer,provider/escalation,provider/audit' };
  const cli = spawnSync(process.execPath, [CLI, '--work-root', root, '--queue', 'queue.json', '--handler', join(root, 'handler.mjs'), '--routing', join(root, 'routing.json')], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).outcomes[0].status, 'queued');
  assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), { decision: question, model: 'provider/escalation', attempt: 1 });
}));
