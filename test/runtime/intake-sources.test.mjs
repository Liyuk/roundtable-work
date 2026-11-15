import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAdapter, loadConfig, pollIntake } from '../../runtime/lib/intake-sources.mjs';
import { openInbox } from '../../runtime/lib/event-inbox.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Fake adapter: reports with a duplicate id, a noise report, and private fields that must be stripped.
const FAKE_A = `export default {
  poll: async (since) => [
    { url: 'https://example.test/1', author: 'alice', text: 'roundtable intake works', time: '2026-01-01T00:00:00Z', source_event_id: 'a-1' },
    { url: 'https://example.test/2', author: 'bob', text: 'unrelated noise', time: '2026-01-01T00:01:00Z', source_event_id: 'a-noise' },
    { url: 'https://example.test/1', author: 'alice', text: 'roundtable intake works', time: '2026-01-01T00:00:00Z', source_event_id: 'a-1' },
    { url: 'https://example.test/3', author: 'carol', text: 'Roundtable again', time: '2026-01-01T00:02:00Z', source_event_id: 'a-2', token: 'secret', email: 'x@example.test' },
  ],
  parse: (payload) => [payload],
};
`;

// Second adapter, added later with only a new file plus a config entry.
const FAKE_B = `export default {
  poll: async () => [
    { url: 'https://example.test/b', author: 'dave', text: 'roundtable from b', time: '2026-01-02T00:00:00Z', source_event_id: 'b-1' },
  ],
  parse: (payload) => [payload],
};
`;

async function makeRepo(sources) {
  const root = await mkdtemp(join(tmpdir(), 'intake-sources-'));
  await mkdir(join(root, 'runtime', 'intake-adapters'), { recursive: true });
  await writeFile(join(root, 'runtime', 'intake-adapters', 'fake-a.mjs'), FAKE_A);
  await writeFile(join(root, 'runtime', 'intake-sources.config.json'), JSON.stringify({ sources }));
  return root;
}

const SOURCE_A = { name: 'fake-a', module: 'runtime/intake-adapters/fake-a.mjs', issue: 366, keywords: ['roundtable'] };

test('poll accepts exactly the expected normalized events, de-duplicated and filtered', async () => {
  const root = await makeRepo([SOURCE_A]);
  try {
    const accepted = await pollIntake(root, { receivedAt: 1000 });
    assert.equal(accepted, 2);
    const events = openInbox(root).events();
    assert.deepEqual(events.map((e) => e.source_event_id), ['a-1', 'a-2']);
    assert.deepEqual(events[1], {
      source_event_id: 'a-2', kind: 'intake', issue: 366, receivedAt: 1000,
      payload: { source: 'fake-a', url: 'https://example.test/3', author: 'carol', text: 'Roundtable again', time: '2026-01-01T00:02:00Z', source_event_id: 'a-2' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a second adapter is picked up from config alone, with no runner change', async () => {
  const root = await makeRepo([SOURCE_A]);
  try {
    await pollIntake(root, { receivedAt: 1 });
    await writeFile(join(root, 'runtime', 'intake-adapters', 'fake-b.mjs'), FAKE_B);
    await writeFile(join(root, 'runtime', 'intake-sources.config.json'), JSON.stringify({
      sources: [SOURCE_A, { name: 'fake-b', module: 'runtime/intake-adapters/fake-b.mjs' }],
    }));
    assert.equal(await pollIntake(root, { receivedAt: 2 }), 1);
    const ids = openInbox(root).events().map((e) => e.source_event_id);
    assert.deepEqual(ids, ['a-1', 'a-2', 'b-1']);
    assert.equal(openInbox(root).events()[2].issue, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adapter contract exposes only poll and parse, with no write method', async () => {
  const root = await makeRepo([SOURCE_A]);
  try {
    const adapter = await loadAdapter(root, SOURCE_A.module);
    assert.deepEqual(Object.keys(adapter).sort(), ['parse', 'poll']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shipped config loads with no sources configured', () => {
  assert.deepEqual(loadConfig(REPO), []);
});
