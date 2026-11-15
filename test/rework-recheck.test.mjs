import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const skill = new URL('../.agents/skills/roundtable-work/', import.meta.url);
const assignment = readFileSync(new URL('templates/assignment.md', skill), 'utf8');
const reviewer = readFileSync(new URL('prompts/roles/reviewer.md', skill), 'utf8');

test('assignment template requires re-checking every acceptance item before a rework is submitted', () => {
  assert.match(assignment, /rework/i);
  assert.match(assignment, /before (a )?rework[^\n]*submitted[^\n]*every acceptance item/i);
  assert.match(assignment, /every acceptance item[^\n]*one by one/i);
  assert.match(assignment, /pass\/fail[^\n]*evidence/i);
});

test('reviewer prompt checks all acceptance items even when a rework fixes only part of the rejected items', () => {
  assert.match(reviewer, /rework[^\n]*only part[^\n]*rejected[^\n]*all acceptance items/i);
  assert.match(reviewer, /re-checking only the rejected items[^\n]*not[^\n]*pass/i);
});
