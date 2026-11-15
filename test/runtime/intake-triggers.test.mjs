import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schedulePoll, verifySignature, webhookIngest } from '../../runtime/lib/intake-triggers.mjs';
import { INBOX_PATH } from '../../runtime/lib/event-inbox.mjs';

const SECRET = 'test-secret';
const REPORTS = [
  { url: 'https://example.test/1', author: 'alice', text: 'roundtable via trigger', time: '2026-01-01T00:00:00Z', source_event_id: 'w-1', token: 'secret' },
  { url: 'https://example.test/2', author: 'bob', text: 'unrelated noise', time: '2026-01-01T00:01:00Z', source_event_id: 'w-noise' },
];
const ADAPTER = `export default {
  poll: async () => ${JSON.stringify(REPORTS)},
  parse: (payload) => payload.reports,
};
`;
const SOURCE = { name: 'fake', module: 'runtime/intake-adapters/fake.mjs', issue: 366, keywords: ['roundtable'] };
const BODY = Buffer.from(JSON.stringify({ reports: REPORTS }));
const sign = (body, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

async function makeRepo() {
  const root = await mkdtemp(join(tmpdir(), 'intake-triggers-'));
  await mkdir(join(root, 'runtime', 'intake-adapters'), { recursive: true });
  await writeFile(join(root, 'runtime', 'intake-adapters', 'fake.mjs'), ADAPTER);
  await writeFile(join(root, 'runtime', 'intake-sources.config.json'), JSON.stringify({ sources: [SOURCE] }));
  return root;
}

const hook = (root, overrides = {}) => webhookIngest(root, {
  source: 'fake', secret: SECRET, rawBody: BODY, signatureHeader: sign(BODY), receivedAt: 1000, ...overrides,
});

test('poll and signed webhook store byte-identical events with the same source_event_id, once', async () => {
  const pollRoot = await makeRepo();
  const hookRoot = await makeRepo();
  try {
    assert.equal(await schedulePoll(pollRoot, { receivedAt: 1000 }), 1);
    assert.deepEqual(await hook(hookRoot), { accepted: 1 });
    const fromPoll = await readFile(join(pollRoot, INBOX_PATH));
    assert.deepEqual(fromPoll, await readFile(join(hookRoot, INBOX_PATH)));
    assert.deepEqual(await hook(pollRoot), { accepted: 0 });
    assert.deepEqual(await readFile(join(pollRoot, INBOX_PATH)), fromPoll);
    assert.equal(JSON.parse(fromPoll.toString()).source_event_id, 'w-1');
  } finally {
    await rm(pollRoot, { recursive: true, force: true });
    await rm(hookRoot, { recursive: true, force: true });
  }
});

test('unsigned, wrong-signature, and malformed-signature payloads enqueue nothing', async () => {
  const root = await makeRepo();
  try {
    const bad = [
      undefined,
      '',
      sign(BODY, 'other-secret'),
      sign(Buffer.from('{"reports":[]}')),
      'sha1=' + createHmac('sha1', SECRET).update(BODY).digest('hex'),
      sign(BODY).slice(0, -2),
      sign(BODY).toUpperCase().replace('SHA256', 'sha256'),
      'sha256=' + 'g'.repeat(64),
      ['sha256=' + 'a'.repeat(64)],
    ];
    for (const signatureHeader of bad) {
      assert.deepEqual(await hook(root, { signatureHeader }), { accepted: 0, rejected: 'bad_signature' });
    }
    await assert.rejects(readFile(join(root, INBOX_PATH)), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a valid signature from an unknown source enqueues nothing', async () => {
  const root = await makeRepo();
  try {
    assert.deepEqual(await hook(root, { source: 'nope' }), { accepted: 0, rejected: 'unknown_source' });
    await assert.rejects(readFile(join(root, INBOX_PATH)), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verifySignature accepts the exact HMAC of the raw bytes, as Buffer or string', () => {
  assert.equal(verifySignature(BODY, sign(BODY), SECRET), true);
  assert.equal(verifySignature(BODY.toString(), sign(BODY), SECRET), true);
  assert.equal(verifySignature(BODY, sign(BODY), 'other-secret'), false);
});

test('triggers make no outbound request and do not import network modules', async () => {
  const root = await makeRepo();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => { calls++; throw new Error('network blocked'); };
  try {
    await schedulePoll(root, { receivedAt: 1 });
    await hook(root);
    assert.equal(calls, 0);
    const src = await readFile(new URL('../../runtime/lib/intake-triggers.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /from\s+['"](node:)?(http|https|net|child_process|dgram|tls)['"]/);
    assert.doesNotMatch(src, /\bfetch\b/);
  } finally {
    globalThis.fetch = realFetch;
    await rm(root, { recursive: true, force: true });
  }
});
