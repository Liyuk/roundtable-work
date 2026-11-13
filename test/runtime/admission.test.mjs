import test from 'node:test';
import assert from 'node:assert/strict';
import { admission, selectIssues } from '../../runtime/lib/intake.mjs';
import { createIntakeProvider } from '../../runtime/lib/intake.mjs';
import { createGitHubReader } from '../../scripts/github-read.mjs';

const complete = `## Goal\nAdd an admission check.\n\n## Acceptance criteria\n- Run: \`node --test test/runtime/admission.test.mjs\`; Expected: exit 0.\n\n## Out of scope\nGitHub writes and decomposition.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 120\nFiles: 3`;
const issue = (body, extra = {}) => ({ number: 1, title: 'Admission', body, state: 'OPEN', author: { login: 'owner' }, labels: ['type:feature'], ...extra });

test('admits a complete ticket with executable, expected acceptance and explicit boundaries', () => {
  assert.deepEqual(admission(issue(complete)), { admitted: true, reasons: [], missing: [], needsHuman: false, source: 'body' });
});

test('returns structured missing-field reasons for incomplete tickets', () => {
  const result = admission(issue('## Goal\nDo work.'));
  assert.equal(result.admitted, false);
  assert.deepEqual(result.missing, ['acceptance_command', 'acceptance_expected_result', 'out_of_scope', 'dependencies', 'size_lines', 'size_files']);
  assert.equal(result.needsHuman, false);
});

test('refuses oversized and unparseable estimates with a decompose decision', () => {
  for (const size of ['Changed lines: 401\nFiles: 2', 'Changed lines: 200\nFiles: 6', 'Changed lines: many\nFiles: 2', 'Changed lines: 20.5\nFiles: 2']) {
    const result = admission(issue(complete.replace('Changed lines: 120\nFiles: 3', size)));
    assert.equal(result.admitted, false, size);
    assert.equal(result.decision, 'decompose', size);
  }
});

test('missing acceptance asks a person only when the draft says human judgment is required', () => {
  const draft = complete.replace('- Run:', '').replace('Expected:', 'Expected:');
  const result = admission(issue(draft.replace('## Acceptance criteria', '## Acceptance criteria\nNeeds human decision: yes')));
  assert.equal(result.admitted, false);
  assert.equal(result.needsHuman, true);
  assert.equal(result.decision, 'ask');
  const markedDraftText = complete.replace(/## Acceptance criteria[\s\S]*?## Out of scope/, '## Acceptance criteria\nNeeds human decision: yes\n\n## Out of scope');
  const markedDraft = admission(issue('## Goal\nDraft pending.', { comments: [{ body: `<!-- rt:admission-draft -->\n${markedDraftText}` }] }));
  assert.equal(markedDraft.admitted, false);
  assert.equal(markedDraft.needsHuman, true);
  assert.equal(markedDraft.decision, 'ask');
});

test('accepts a complete Chief draft comment without asking for a person', () => {
  const result = admission(issue(''));
  const withDraft = admission(issue('', { comments: [{ body: `<!-- rt:admission-draft -->\n${complete}` }] }));
  assert.equal(result.admitted, false);
  assert.deepEqual(withDraft, { admitted: true, reasons: [], missing: [], needsHuman: false, source: 'chief_draft' });
});

test('intake excludes refused issues before they can reach the claim queue and stays read-only', () => {
  const rejected = issue('## Goal\nIncomplete.', { labels: ['type:feature'] });
  const accepted = issue(complete, { number: 2, labels: ['type:feature'] });
  const result = selectIssues({ issues: [rejected, accepted], owner: 'owner' });
  assert.deepEqual(result.issues.map(({ id }) => id), ['2']);
  assert.deepEqual(result.admission, [{ id: '1', admitted: false, reasons: [
    { code: 'missing_field', field: 'acceptance_command' },
    { code: 'missing_field', field: 'acceptance_expected_result' },
    { code: 'missing_field', field: 'out_of_scope' },
    { code: 'missing_field', field: 'dependencies' },
    { code: 'missing_field', field: 'size_lines' },
    { code: 'missing_field', field: 'size_files' },
    { code: 'size_unparseable', decision: 'decompose' },
  ], missing: ['acceptance_command', 'acceptance_expected_result', 'out_of_scope', 'dependencies', 'size_lines', 'size_files'], needsHuman: false, decision: 'decompose' }]);
});

test('provider reads comments only to find a complete marked Chief draft', async () => {
  const calls = [];
  const candidate = issue('## Goal\nDraft pending.');
  const provider = createIntakeProvider({
    getOwner: async () => 'owner',
    listIssues: async () => [candidate],
    getIssue: async () => { throw new Error('no dependencies to resolve'); },
    listComments: async number => { calls.push(number); return [{ body: `<!-- rt:admission-draft -->\n${complete}` }]; },
  });
  assert.deepEqual((await provider()).map(({ id }) => id), ['1']);
  assert.deepEqual(calls, [1]);
  assert.deepEqual(provider.admission, []);
});

test('dependencies in a Chief draft use the existing closed-dependency gate', async () => {
  let state = 'OPEN';
  const candidate = issue('## Goal\nDraft pending.');
  const provider = createIntakeProvider({
    getOwner: async () => 'owner',
    listIssues: async () => [candidate],
    getIssue: async () => ({ state }),
    listComments: async () => [{ body: `<!-- rt:admission-draft -->\n${complete.replace('Dependencies\nNone.', 'Dependencies\nDepends on #42')}` }],
  });
  assert.deepEqual(await provider(), []);
  state = 'CLOSED';
  assert.deepEqual((await provider()).map(({ id }) => id), ['1']);
});

test('GitHub reader exposes a read-only comment lookup for draft admission', async () => {
  const calls = [];
  const reader = createGitHubReader({ repo: 'owner/repo', run: async args => { calls.push(args); return { comments: [{ body: 'draft' }] }; } });
  assert.deepEqual(await reader.listComments(12), [{ body: 'draft' }]);
  assert.deepEqual(calls, [['issue', 'view', '12', '--repo', 'owner/repo', '--json', 'comments']]);
});
