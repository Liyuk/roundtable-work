import test from 'node:test';
import assert from 'node:assert/strict';
import { similarity, tokens, overlappingIssues } from '../../runtime/lib/overlap.mjs';
import { admission, selectIssues, createIntakeProvider } from '../../runtime/lib/intake.mjs';

const NOW = Date.parse('2026-11-15T00:00:00Z');
const DAY = 86_400_000;
const body = (acceptance, extra = '') => `## Goal\nFixture task.\n\n## Acceptance criteria\n${acceptance}\n\n## Out of scope\nNone.\n\n## Dependencies\nNone.\n\n## Size estimate\nChanged lines: 20\nFiles: 2${extra}`;

const draft = {
  number: 287,
  title: '[RT-U2] Port loop rules, single source of state, shadow mode and cutover',
  state: 'OPEN',
  author: { login: 'owner' },
  labels: [{ name: 'type:feature' }],
  createdAt: '2025-01-01T00:00:00Z',
  body: body('- Port the loop rules into the runtime.\n- Keep one single source of state.\n- Run shadow mode before cutover.\n\nRun: `npm test`; Expected: exit 0.'),
};
const closed231 = (closedAt = NOW - DAY) => ({
  number: 231,
  title: '[RT-U] Port loop rules and state-as-truth shadow mode',
  state: 'CLOSED',
  closedAt: new Date(closedAt).toISOString(),
  body: body('- Port loop rules from the legacy scripts.\n- State is the single source of truth.\n- Shadow mode compares outputs before cutover.'),
});
const unrelated = {
  number: 99,
  title: 'Fix dark mode colors in settings page',
  state: 'CLOSED',
  closedAt: new Date(NOW - DAY).toISOString(),
  body: body('- Dark mode uses readable contrast colors.\n- Settings page renders correctly.'),
};
const scopeRefusal = { code: 'scope_overlap', issues: [231], decision: 'reask' };

test('similarity is deterministic Jaccard over tokens and 0 for empty sets', () => {
  assert.equal(similarity(new Set(), new Set()), 0);
  assert.equal(similarity(tokens('alpha beta gamma'), tokens('beta gamma delta')), 0.5);
  assert.equal(similarity(tokens('Alpha, beta'), tokens('alpha BETA')), 1);
});

test('closed issues outside the window do not count as overlap', () => {
  assert.deepEqual(overlappingIssues(draft, [closed231(NOW - 20 * DAY)], { now: NOW }), []);
  assert.deepEqual(overlappingIssues(draft, [closed231(NOW - 2 * DAY)], { now: NOW, days: 14 }), [231]);
  assert.deepEqual(overlappingIssues(draft, [closed231(NOW - 2 * DAY)], { now: NOW, days: 1 }), []);
  assert.equal(admission(draft, { closed: [closed231(NOW - 20 * DAY)], now: NOW }).admitted, true);
});

test('fixture shaped like #287 triggers the check against #231', () => {
  assert.deepEqual(overlappingIssues(draft, [closed231()], { now: NOW }), [231]);
});

test('overlap without Builds on and Delta is refused as a re-ask', () => {
  const result = admission(draft, { closed: [closed231()], now: NOW });
  assert.equal(result.admitted, false);
  assert.deepEqual(result.reasons.find(reason => reason.code === 'scope_overlap'), scopeRefusal);
  assert.equal(result.decision, 'reask');
});

test('overlap with Builds on #231 and a non-empty Delta is admitted', () => {
  const built = { ...draft, body: draft.body + '\n\n## Delta\nAdds the shadow cutover comparison only.' };
  const cited = { ...built, body: built.body.replace('## Goal', '## Goal\nBuilds on #231.') };
  assert.equal(admission(cited, { closed: [closed231()], now: NOW }).admitted, true);
  const emptyDelta = { ...draft, body: draft.body.replace('## Goal', '## Goal\nBuilds on #231.') + '\n\n## Delta\n' };
  assert.equal(admission(emptyDelta, { closed: [closed231()], now: NOW }).admitted, false);
});

test('unrelated closed issue does not trigger the check', () => {
  assert.deepEqual(overlappingIssues(draft, [unrelated], { now: NOW }), []);
  assert.equal(admission(draft, { closed: [unrelated], now: NOW }).admitted, true);
});

test('intake provider loads closed issues and refuses the overlapping draft', async () => {
  const issues = [draft];
  const withClosed = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => issues, listClosedIssues: async () => [closed231(Date.now() - DAY)] });
  const queue = await withClosed({});
  assert.deepEqual(queue, []);
  assert.deepEqual(withClosed.admission.map(entry => entry.id), ['287']);
  assert.equal(withClosed.admission[0].reasons.find(reason => reason.code === 'scope_overlap').issues[0], 231);

  const withoutClosed = createIntakeProvider({ getOwner: async () => 'owner', listIssues: async () => issues });
  assert.equal((await withoutClosed({})).length, 1);
});

test('selectIssues accepts closed issues as scope input', () => {
  const result = selectIssues({ issues: [draft], owner: 'owner', closed: [closed231()], now: NOW });
  assert.deepEqual(result.issues, []);
  assert.equal(result.admission[0].decision, 'reask');
});
