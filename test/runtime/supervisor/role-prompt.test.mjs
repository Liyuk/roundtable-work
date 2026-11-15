import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assembleRolePrompt } from '../../../runtime/lib/role-prompt.mjs';

const CHIEF = await readFile(new URL('../../../.agents/skills/roundtable-work/prompts/roles/chief.md', import.meta.url), 'utf8');
const SUPERVISOR = await readFile(new URL('../../../runtime/prompts/supervisor.md', import.meta.url), 'utf8');
const SUPERVISOR_MARKER = '# Supervisor instructions';

test('chief prompt is the chief role file and carries no supervisor instructions', async () => {
  const prompt = await assembleRolePrompt('chief');
  assert.equal(prompt, CHIEF);
  assert.ok(!prompt.includes(SUPERVISOR_MARKER));
});

test('supervisor prompt is assembled from runtime/prompts/supervisor.md and carries the supervisor instructions', async () => {
  const prompt = await assembleRolePrompt('supervisor');
  assert.equal(prompt, SUPERVISOR);
  assert.ok(prompt.includes(SUPERVISOR_MARKER));
  assert.match(prompt, /observe-only/);
});

test('assembleRolePrompt reads through the injected readFile at the module-relative path', async () => {
  const paths = [];
  const readFileSpy = async (path, enc) => { paths.push(path); return `text:${enc}`; };
  assert.equal(await assembleRolePrompt('supervisor', { readFile: readFileSpy }), 'text:utf8');
  assert.match(paths[0], /runtime\/prompts\/supervisor\.md$/);
});

test('an unknown role throws TypeError, including prototype names', async () => {
  await assert.rejects(assembleRolePrompt('developer'), TypeError);
  await assert.rejects(assembleRolePrompt('constructor'), TypeError);
  await assert.rejects(assembleRolePrompt(undefined), TypeError);
});
