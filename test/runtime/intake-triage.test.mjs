import test from 'node:test';
import assert from 'node:assert/strict';
import { planTriage } from '../../runtime/lib/intake-triage.mjs';

const SRC = 'fake-forum';
const report = (over) => ({
  source: SRC,
  url: 'https://fake.example/r/1',
  author: 'alice',
  text: 'Crash on save',
  time: '2026-01-01T00:00:00Z',
  source_event_id: 'e1',
  ...over,
});

test('fake batch with duplicates and noise yields exact planned issues', () => {
  const reports = [
    report({ url: 'https://fake.example/r/1', author: 'alice', text: 'Crash on save', source_event_id: 'e1' }),
    report({ url: 'https://fake.example/r/2', author: 'bob', text: '  crash   ON  save ', source_event_id: 'e2' }),
    report({ url: 'https://fake.example/r/3', author: 'carol', text: '   ', source_event_id: 'e3' }),
    report({ url: 'https://fake.example/r/4', author: 'dave', text: 'Typo in footer', source_event_id: 'e4' }),
    report({ url: 'https://fake.example/r/5', author: 'spam', text: 'Crash on save buy now', source_event_id: 'e5' }),
    report({ url: 'https://fake.example/r/6', author: 'eve', text: 'Typo in footer', source_event_id: 'e6' }),
  ];
  const { plans } = planTriage({
    reports,
    openIssues: [],
    sourceLabel: SRC,
    keywords: ['save', 'footer'],
    excludeAuthors: ['SPAM'],
  });
  assert.deepEqual(plans, [
    {
      kind: 'create',
      title: 'Crash on save',
      body: [
        'Source reports:',
        '- https://fake.example/r/1 (alice)',
        '- https://fake.example/r/2 (bob)',
        '',
        'Reproduction summary:',
        'Crash on save',
        '',
        'Acceptance criteria:',
        '1. The reported behavior no longer occurs for: Crash on save',
        '2. Test covering it passes',
      ].join('\n'),
      labels: ['rt:go', SRC],
    },
    {
      kind: 'create',
      title: 'Typo in footer',
      body: [
        'Source reports:',
        '- https://fake.example/r/4 (dave)',
        '- https://fake.example/r/6 (eve)',
        '',
        'Reproduction summary:',
        'Typo in footer',
        '',
        'Acceptance criteria:',
        '1. The reported behavior no longer occurs for: Typo in footer',
        '2. Test covering it passes',
      ].join('\n'),
      labels: ['rt:go', SRC],
    },
  ]);
});

test('report matching an open issue plans a comment on it, not a new issue', () => {
  const { plans } = planTriage({
    reports: [report({ text: 'Crash on save happens daily' })],
    openIssues: [{ number: 7, title: 'crash on SAVE', url: 'https://fake.example/issues/7' }],
    sourceLabel: SRC,
  });
  assert.deepEqual(plans, [
    { kind: 'comment', issue: 7, url: 'https://fake.example/issues/7', reports: ['https://fake.example/r/1'] },
  ]);
});

test('plans carry no private report fields such as token or email', () => {
  const { plans } = planTriage({
    reports: [report({ text: 'Login fails', token: 'SECRET-TOKEN-123', email: 'alice@private.example' })],
    openIssues: [],
    sourceLabel: SRC,
  });
  const serialized = JSON.stringify(plans);
  assert.equal(serialized.includes('SECRET-TOKEN-123'), false);
  assert.equal(serialized.includes('alice@private.example'), false);
  assert.equal(plans.length, 1);
});
