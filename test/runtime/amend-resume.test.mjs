import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { makeAmendResume } from '../../runtime/lib/amend-resume.mjs';

// Fake spawn: records the call and exits with `code` on the next tick, like a child process.
const fakeSpawn = (code, calls) => (command, args, options) => {
  calls.push({ command, args, options });
  const child = new EventEmitter();
  setImmediate(() => child.emit('exit', code));
  return child;
};

test('amend resume launches the stored session in resume mode with the owner text as prompt', async () => {
  const calls = [];
  const resume = makeAmendResume({ workspace: '/ws', adapterName: 'codex', spawnFn: fakeSpawn(0, calls) });
  await resume({ sessionId: 'sess-7', text: 'use a smaller diff' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'codex');
  assert.deepEqual(calls[0].args, ['exec', 'resume', 'sess-7', 'use a smaller diff']);
  assert.equal(calls[0].options.cwd, '/ws');
});

test('amend resume throws when the launched agent exits non-zero', async () => {
  const resume = makeAmendResume({ workspace: '/ws', adapterName: 'pi', spawnFn: fakeSpawn(3, []) });
  await assert.rejects(resume({ sessionId: 'sess-7', text: 'x' }), /amend resume exited with code 3/);
});
