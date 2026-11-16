// The shipped CLI path must run the pre-dispatch preflight from the trusted handler module (ticket 84, F1-F2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RTD = fileURLToPath(new URL('../../runtime/rtd.mjs', import.meta.url));
const ROUTING = fileURLToPath(new URL('./routing-fixture.json', import.meta.url));
const OBSERVATION = `
const sha = 'a'.repeat(40);
export const observationClients = {
  expectedSha: () => sha,
  issue: { async get() { return { state: 'open', labels: ['rt:running'] }; } },
  worktree: { async inspect() { return { dirty: false }; } },
  git: { async head() { return sha; }, async commit() { return { sha }; } },
  evidence: { async checks() { return { sha, conclusion: 'success' }; }, async review() { return { sha, conclusion: 'approved' }; } },
};`;
const HANDLER = (preDispatch) => `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
${OBSERVATION}
export default async function handler({ phase }) {
  writeFileSync(join(process.env.RT_TEST_ROOT, 'called-' + phase), '1');
  return { exitCode: 0, output: phase === 'reviewing' ? 'Verdict: pass' : 'ok' };
}
${preDispatch}
`;

async function setup(preDispatch) {
  const root = await mkdtemp(join(tmpdir(), 'rt-predispatch-cli-'));
  await writeFile(join(root, 'queue.json'), JSON.stringify([{ id: '84' }]));
  await writeFile(join(root, 'handler.mjs'), HANDLER(preDispatch));
  const child = spawn(process.execPath, [RTD, '--work-root', root, '--queue', 'queue.json', '--routing', ROUTING, '--handler', join(root, 'handler.mjs')],
    { env: { ...process.env, RT_TEST_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  return { root, code, out, err, called: (phase) => existsSync(join(root, `called-${phase}`)) };
}

test('a failing preDispatch from the trusted handler stops the wake before the implementer runs', { timeout: 20000 }, async () => {
  const r = await setup('export async function preDispatch() { return { ok: false, reason: "missing_convention_file:CLAUDE.md" }; }');
  try {
    assert.equal(r.code, 0, r.err);
    assert.equal(r.called('developing'), false);
    const result = JSON.parse(r.out);
    assert.deepEqual([result.outcomes[0].status, result.outcomes[0].class, result.outcomes[0].reason], ['stop', 'predispatch_failed', 'missing_convention_file:CLAUDE.md']);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test('a handler module without a preDispatch export fails closed with exit 2 and never runs the handler', { timeout: 20000 }, async () => {
  const r = await setup('');
  try {
    assert.equal(r.code, 2);
    assert.match(r.err, /preDispatch/);
    assert.equal(r.called('developing'), false);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});

test('a passing preDispatch from the trusted handler lets the wake proceed', { timeout: 20000 }, async () => {
  const r = await setup('export async function preDispatch() { return { ok: true }; }');
  try {
    assert.equal(r.code, 0, r.err);
    assert.equal(r.called('developing'), true);
  } finally { await rm(r.root, { recursive: true, force: true }); }
});
