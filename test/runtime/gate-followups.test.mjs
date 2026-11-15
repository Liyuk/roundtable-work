import test from 'node:test';
import assert from 'node:assert/strict';
import { reportReviewFindings, triageFindings, fingerprint } from '../../runtime/lib/review-ledger.mjs';
import { startsFixRound } from '../../runtime/lib/gates.mjs';

const NOTES = '<!-- rt:review-notes -->';
const on = { createFollowupIssues: true };
const off = { createFollowupIssues: false };
const finding = (id, severity, extra = {}) => ({ id, summary: `Summary ${id}`, severity, classification: 'in-scope miss', ...extra });
const fakeGithub = ({ comments = [] } = {}) => {
  const calls = [];
  return {
    calls,
    listComments: async () => comments,
    createComment: async (pr, body) => { calls.push(['createComment', pr, body]); return { id: 1 }; },
    updateComment: async (id, body) => { calls.push(['updateComment', id, body]); return { id }; },
    createIssue: async (issue) => { calls.push(['createIssue', issue]); return { number: 9 }; },
  };
}
const issuesOf = calls => calls.filter(([type]) => type === 'createIssue').map(([, issue]) => issue.title);

test('only in-scope high and critical findings file follow-up issues', async () => {
  const github = fakeGithub();
  const findings = [
    finding('H1', 'high'), finding('C1', 'critical'), finding('M1', 'medium'), finding('L1', 'low'),
    finding('O1', 'high', { classification: 'out-of-scope follow-up' }),
  ];
  await reportReviewFindings({ github, pr: 5, findings, config: on });
  assert.deepEqual(issuesOf(github.calls), ['Follow-up H1: Summary H1', 'Follow-up C1: Summary C1']);
});

test('no follow-up issues are filed while the switch is off', async () => {
  const github = fakeGithub();
  const result = await reportReviewFindings({ github, pr: 5, findings: [finding('H1', 'high')], config: off });
  assert.deepEqual(result.issues, []);
  assert.deepEqual(issuesOf(github.calls), []);
});

test('medium and low findings go into one PR comment created once and updated in place', async () => {
  const findings = [finding('M1', 'medium'), finding('L1', 'low'), finding('H1', 'high')];
  const first = fakeGithub();
  await reportReviewFindings({ github: first, pr: 5, findings, config: on });
  assert.deepEqual(first.calls.map(([type]) => type), ['createIssue', 'createComment']);
  const [, , body] = first.calls[1];
  assert.match(body, /^<!-- rt:review-notes -->\n/);
  assert.match(body, /M1 \(medium\)/);
  assert.match(body, /L1 \(low\)/);
  assert.doesNotMatch(body, /H1/);

  const later = fakeGithub({ comments: [{ id: 42, body: `${NOTES}\nold` }, { id: 3, body: 'owner note' }] });
  await reportReviewFindings({ github: later, pr: 5, findings, config: on });
  assert.deepEqual(later.calls.map(([type]) => type), ['createIssue', 'updateComment']);
  assert.equal(later.calls[1][1], 42);
  assert.match(later.calls[1][2], /M1 \(medium\)/);
});

test('fingerprints are stable for the same file, rule, and normalized message', () => {
  const base = { file: 'runtime/lib/gates.mjs', rule: 'no-dup', summary: 'Retry   Logic\nis wrong' };
  assert.equal(fingerprint(base), fingerprint({ ...base, summary: '  retry logic is WRONG ' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, file: 'runtime/lib/other.mjs' }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, rule: 'other-rule' }));
});

test('a finding fixed or waived in an earlier round is re-raised as repeat, not new', async () => {
  const fixedEarlier = { ...finding('F1', 'high', { classification: 'blocking' }), file: 'a.mjs', rule: 'r' };
  const waivedEarlier = { ...finding('F2', 'medium', { classification: 'blocking' }), file: 'b.mjs', rule: 'r' };
  const previous = [
    { fingerprint: fingerprint(fixedEarlier), status: 'fixed' },
    { fingerprint: fingerprint(waivedEarlier), status: 'waived' },
  ];
  const [fixed, waived] = triageFindings([fixedEarlier, waivedEarlier], previous);
  assert.equal(fixed.repeat, true);
  assert.equal(waived.repeat, true);
  assert.equal(fixed.status, 'fixed');
  assert.equal(waived.status, 'waived');

  const github = fakeGithub();
  await reportReviewFindings({ github, pr: 5, findings: [fixedEarlier], config: on, previous });
  assert.deepEqual(issuesOf(github.calls), []);
  assert.match(github.calls.at(-1)[2], /F1 \(high\) repeat/);
});

test('an open repeat is still open and a new finding is not a repeat', () => {
  const open = { id: 'F3', summary: 'Still broken', severity: 'low', classification: 'blocking' };
  const [same, fresh] = triageFindings([open, { ...open, id: 'F4', summary: 'Other' }], [{ fingerprint: fingerprint(open), status: 'open' }]);
  assert.deepEqual([same.repeat, same.status], [true, 'open']);
  assert.deepEqual([fresh.repeat, fresh.status], [false, 'open']);
});

test('a fix round starts only for blocking findings that are new or not yet fixed', () => {
  const blocking = { id: 'B1', summary: 'Must fix', severity: 'high', classification: 'blocking' };
  const nonBlocking = { id: 'N1', summary: 'Nit', severity: 'medium', classification: 'in-scope miss' };
  const previous = [
    { fingerprint: fingerprint(blocking), status: 'fixed' },
    { fingerprint: fingerprint(nonBlocking), status: 'open' },
  ];
  assert.equal(startsFixRound([blocking], previous), false);
  assert.equal(startsFixRound([nonBlocking], previous), false);
  assert.equal(startsFixRound([blocking], []), true);
  assert.equal(startsFixRound([blocking], [{ fingerprint: fingerprint(blocking), status: 'open' }]), true);
  assert.equal(startsFixRound([{ ...nonBlocking, id: 'N2', summary: 'New nit' }], []), false);
});
