import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewerPrompt, reviewInSession, runSeparateReviewer } from '../../runtime/lib/reviewer-session.mjs';
import { runGates } from '../../runtime/lib/gates.mjs';

const GATE0 = 'Gate 0 passed: 412 tests, 0 failures on head h1';

async function fakePi(dir, verdict) {
  const file = join(dir, 'fake-pi');
  await writeFile(file, `#!/bin/sh
echo $$ > "$RT_FAKE_PID_FILE"
printf '%s' "$@" > "$RT_FAKE_ARGS_FILE"
printf '%s\\n' '审查结论：${verdict}'
echo 'Reviewed the diff against the acceptance criteria and found no defects in the changed behaviour.'
`);
  await chmod(file, 0o755);
  return file;
}

async function withFake(verdict, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rt244-reviewer-'));
  try {
    const command = await fakePi(dir, verdict);
    const env = { ...process.env, RT_REVIEWER_COMMAND: command, RT_FAKE_PID_FILE: join(dir, 'pid'), RT_FAKE_ARGS_FILE: join(dir, 'args') };
    await fn({ env, dir });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('the reviewer prompt carries the recorded Gate 0 summary and forbids running tests', () => {
  const prompt = buildReviewerPrompt({ head: 'h1', gate0Summary: GATE0 });
  assert.match(prompt, /Gate 0 passed: 412 tests, 0 failures on head h1/);
  assert.match(prompt, /审查结论：通过.*审查结论：打回.*审查结论：阻塞/s);
  assert.match(prompt, /do not run tests/i);
});

test('the separate reviewer runs in another OS process and its verdict is an independent Gate 1 pass', async () => {
  await withFake('通过', async ({ env, dir }) => {
    const result = await runSeparateReviewer({ head: 'h1', gate0Summary: GATE0, env });
    const childPid = Number(await readFile(join(dir, 'pid'), 'utf8'));
    assert.notEqual(result.pid, process.pid);
    assert.equal(result.pid, childPid);
    assert.equal(result.exitCode, 0);
    assert.deepEqual({ status: result.status, head: result.head, independent: result.independent }, { status: 'pass', head: 'h1', independent: true });
    assert.match(await readFile(join(dir, 'args'), 'utf8'), /Gate 0 passed: 412 tests/);
  });
});

test('a rejected verdict from the separate reviewer is not a pass', async () => {
  await withFake('打回', async ({ env }) => {
    const result = await runSeparateReviewer({ head: 'h1', gate0Summary: GATE0, env });
    assert.equal(result.status, 'reject');
  });
});

test('a separate reviewer without a verdict line is blocked, not passed', async () => {
  await withFake('nonsense', async ({ env }) => {
    const result = await runSeparateReviewer({ head: 'h1', gate0Summary: GATE0, env });
    assert.equal(result.status, 'blocked');
  });
});

test('the independent reviewer pass is accepted by runGates as Gate 1', async () => {
  await withFake('通过', async ({ env }) => {
    const records = new Map();
    const result = await runGates({
      issue: '244', head: 'h1', tree: 't1', changedFiles: [], models: { reviewer: 'pi' },
      state: { async get(id) { return records.get(id); }, async put(id, value) { records.set(id, structuredClone(value)); } },
      gates: {
        async gate0() { return { passed: true }; },
        reviewer: ({ head }) => runSeparateReviewer({ head, gate0Summary: GATE0, env }),
      },
      ci: { async requiredGreen() { return { green: true }; } },
      merge: { async squash() { return { merged: true }; } },
      github: { async recordedEscalationApproval() { return null; }, async addLabel() {} },
    });
    assert.equal(result.status, 'merged');
    assert.ok(records.get('244').passed.includes('gate1'));
  });
});

test('single-session review is marked not independent and never passes Gate 1', async () => {
  const result = await reviewInSession({ head: 'h1', gate0Summary: GATE0, review: async (prompt) => {
    assert.match(prompt, /Gate 0 passed: 412 tests/);
    return '审查结论：通过';
  } });
  assert.equal(result.independent, false);
  assert.equal(result.note, 'not independent');

  const records = new Map();
  const gated = await runGates({
    issue: '244', head: 'h1', tree: 't1', changedFiles: [], models: { reviewer: 'pi' },
    state: { async get(id) { return records.get(id); }, async put(id, value) { records.set(id, structuredClone(value)); } },
    gates: { async gate0() { return { passed: true }; }, reviewer: async () => result },
    ci: { async requiredGreen() { return { green: true }; } },
    merge: { async squash() { throw new Error('must not merge'); } },
    github: { async recordedEscalationApproval() { return null; }, async addLabel() {} },
  });
  assert.equal(gated.status, 'blocked');
  assert.equal(gated.gate, 'gate1');
  assert.ok(!records.get('244')?.passed.includes('gate1'));
});
