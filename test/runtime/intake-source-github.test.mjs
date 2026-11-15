import test from 'node:test';
import assert from 'node:assert/strict';
import { createGithubIssuesAdapter } from '../../runtime/lib/intake-adapters/github-issues.mjs';

// Fake `gh`: records every argv and returns fixture issues; no real gh call, no network.
const FIXTURE = [
  {
    number: 7, title: 'Roundtable intake', body: 'first body', updatedAt: '2026-01-03T00:00:00Z',
    url: 'https://github.test/o/r/issues/7', author: { login: 'alice', email: 'alice@example.test', id: 'U_1' }, token: 'secret', labels: [],
  },
  {
    number: 8, title: 'Another', body: '', updatedAt: '2026-01-04T00:00:00Z',
    url: 'https://github.test/o/r/issues/8', author: { login: 'bob', email: 'bob@example.test' }, state: 'OPEN',
  },
];

function fakeRun(result = FIXTURE) {
  const calls = [];
  const run = async (args) => { calls.push(args); return result; };
  return { run, calls };
}

test('poll returns exactly the fixture issues as normalized raw reports', async () => {
  const { run } = fakeRun();
  const adapter = createGithubIssuesAdapter({ repo: 'o/r', run });
  const reports = await adapter.poll('2026-01-02T00:00:00.000Z');
  assert.deepEqual(reports, [
    {
      url: 'https://github.test/o/r/issues/7', author: 'alice', text: 'Roundtable intake\nfirst body',
      time: '2026-01-03T00:00:00Z', source_event_id: 'github-issue:7:2026-01-03T00:00:00Z',
    },
    {
      url: 'https://github.test/o/r/issues/8', author: 'bob', text: 'Another\n',
      time: '2026-01-04T00:00:00Z', source_event_id: 'github-issue:8:2026-01-04T00:00:00Z',
    },
  ]);
  assert.deepEqual(Object.keys(reports[0]).sort(), ['author', 'source_event_id', 'text', 'time', 'url']);
});

test('poll only issues read-only gh list/view commands and filters by since', async () => {
  const { run, calls } = fakeRun([]);
  const adapter = createGithubIssuesAdapter({ repo: 'o/r', run });
  await adapter.poll(Date.parse('2026-01-02T00:00:00Z'));
  await adapter.poll(new Date('2026-01-02T00:00:00Z'));
  await adapter.poll();
  for (const args of calls) {
    assert.ok(args[0] === 'issue' && args[1] === 'list', `unexpected argv ${args.join(' ')}`);
    assert.ok(!args.some((a) => /^(create|edit|close|comment|merge|label)$/.test(a)), `write verb in ${args.join(' ')}`);
  }
  assert.deepEqual(calls[0].slice(0, 2), ['issue', 'list']);
  assert.deepEqual(calls[0].slice(calls[0].indexOf('--repo'), calls[0].indexOf('--repo') + 2), ['--repo', 'o/r']);
});

test('poll filters issues locally by updatedAt since', async () => {
  const { run } = fakeRun();
  const adapter = createGithubIssuesAdapter({ repo: 'o/r', run });
  const reports = await adapter.poll(new Date('2026-01-03T12:00:00Z'));
  assert.deepEqual(reports.map((r) => r.url), ['https://github.test/o/r/issues/8']);
});

test('poll rejects a truncated or non-array result', async () => {
  const truncated = createGithubIssuesAdapter({ run: async () => new Array(1000).fill(FIXTURE[0]) });
  await assert.rejects(truncated.poll(), TypeError);
  const notArray = createGithubIssuesAdapter({ run: async () => ({}) });
  await assert.rejects(notArray.poll(), TypeError);
});

test('adapter exposes no write method', () => {
  const adapter = createGithubIssuesAdapter({ run: async () => [] });
  assert.deepEqual(Object.keys(adapter).sort(), ['parse', 'poll']);
});

test('parse maps a single issue or an array of issues', () => {
  const adapter = createGithubIssuesAdapter({ run: async () => [] });
  const [report] = adapter.parse(FIXTURE[0]);
  assert.equal(report.source_event_id, 'github-issue:7:2026-01-03T00:00:00Z');
  assert.equal(adapter.parse(FIXTURE).length, 2);
});
