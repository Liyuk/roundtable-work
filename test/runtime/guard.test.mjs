import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadLimits } from '../../runtime/lib/guard.mjs';

// Seam: loadLimits({ defaultsPath, hostPath }). Host files live in a temp dir; the real home is never read.
const DEFAULTS = resolve(import.meta.dirname, '../../runtime/defaults/limits.json');
const SECRET = 'sk-test-SECRET-123';

async function withHost(content, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'guard-test-'));
  try {
    const hostPath = join(dir, 'limits.json');
    if (content !== undefined) await writeFile(hostPath, content);
    return await fn(hostPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('stricter host values are honored and nothing is clamped', async () => {
  await withHost(JSON.stringify({ maxConcurrentWorkers: 4, maxSessionMinutes: 10, allowAutoFollowups: false }), async (hostPath) => {
    const { limits, clamped } = await loadLimits({ defaultsPath: DEFAULTS, hostPath });
    assert.equal(limits.maxConcurrentWorkers, 4);
    assert.equal(limits.maxSessionMinutes, 10);
    assert.equal(limits.allowAutoFollowups, false);
    assert.deepEqual(clamped, []);
  });
});

test('looser host values are clamped to the defaults and reported', async () => {
  await withHost(JSON.stringify({ maxConcurrentWorkers: 99, allowAutoFollowups: true, maxSessionMinutes: 25 }), async (hostPath) => {
    const { limits, clamped } = await loadLimits({ defaultsPath: DEFAULTS, hostPath });
    assert.equal(limits.maxConcurrentWorkers, 8);
    assert.equal(limits.allowAutoFollowups, false);
    assert.equal(limits.maxSessionMinutes, 25);
    assert.deepEqual(clamped, ['allowAutoFollowups', 'maxConcurrentWorkers']);
  });
});

test('a missing host file yields exactly the defaults', async () => {
  await withHost(undefined, async (hostPath) => {
    const { limits, clamped } = await loadLimits({ defaultsPath: DEFAULTS, hostPath });
    assert.deepEqual(limits, JSON.parse(await readFile(DEFAULTS, 'utf8')));
    assert.deepEqual(clamped, []);
  });
});

test('unknown keys and wrong types are rejected naming only the key', async () => {
  await withHost(JSON.stringify({ notAKey: 1 }), async (hostPath) => {
    await assert.rejects(loadLimits({ defaultsPath: DEFAULTS, hostPath }), /notAKey/);
  });
  await withHost(JSON.stringify({ maxConcurrentWorkers: 'many' }), async (hostPath) => {
    await assert.rejects(loadLimits({ defaultsPath: DEFAULTS, hostPath }), /maxConcurrentWorkers/);
  });
  await withHost(JSON.stringify({ maxConcurrentWorkers: -1 }), async (hostPath) => {
    await assert.rejects(loadLimits({ defaultsPath: DEFAULTS, hostPath }), /maxConcurrentWorkers/);
  });
});

test('error text never contains host file values, even for invalid JSON', async () => {
  const cases = [
    JSON.stringify({ maxConcurrentWorkers: SECRET }),
    `{"maxConcurrentWorkers": ${JSON.stringify(SECRET)}`,
    JSON.stringify([SECRET]),
  ];
  for (const content of cases) {
    await withHost(content, async (hostPath) => {
      const error = await loadLimits({ defaultsPath: DEFAULTS, hostPath }).then(() => null, (err) => err);
      assert.ok(error, `expected an error for ${content}`);
      assert.equal(error.message.includes(SECRET), false);
      assert.equal(String(error.stack ?? '').includes(SECRET), false);
    });
  }
});

test('invalid JSON error names the file path', async () => {
  await withHost('{ not json', async (hostPath) => {
    await assert.rejects(loadLimits({ defaultsPath: DEFAULTS, hostPath }), (err) => err.message.includes(hostPath));
  });
});

test('defaults object is not mutated', async () => {
  await withHost(JSON.stringify({ maxConcurrentWorkers: 3 }), async (hostPath) => {
    const before = await readFile(DEFAULTS, 'utf8');
    const { limits } = await loadLimits({ defaultsPath: DEFAULTS, hostPath });
    limits.maxConcurrentWorkers = 0;
    assert.equal(await readFile(DEFAULTS, 'utf8'), before);
  });
});
