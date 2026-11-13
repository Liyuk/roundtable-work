import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scanHygiene } from '../../runtime/lib/hygiene.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function sources() {
  const files = [...await walk(join(repo, 'runtime')), ...await walk(join(repo, 'test', 'runtime'))];
  const doc = join(repo, 'docs', 'runtime-modules.md');
  files.push(doc);
  const result = [];
  for (const f of files) {
    try { result.push({ file: f.slice(repo.length), text: await readFile(f, 'utf8') }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return result;
}

// This file names the forbidden patterns, so it is excluded from its own scan.
const scanned = async () => (await sources()).filter((s) => !s.file.endsWith('hygiene.test.mjs'));
const runtimeOnly = async () => (await scanned()).filter((s) => s.file.startsWith('runtime/'));

test('runtime code never shells out or touches the network', async () => {
  const files = await runtimeOnly();
  assert.ok(files.length >= 5);
  for (const { file, text } of files) {
    if (file === 'runtime/lib/worktree.mjs') {
      // Git worktree lifecycle is the sole subprocess integration; keep it argument-based and local.
      assert.match(text, /node:child_process/);
      assert.match(text, /execFile/);
      assert.doesNotMatch(text, /\bexec\(/);
    } else assert.doesNotMatch(text, /child_process/, file);
    assert.doesNotMatch(text, /\bgh\s+(issue|pr|api|repo|release|label)\b/, file);
    assert.doesNotMatch(text, /node:(https?|net|dgram|tls)\b|\bfetch\(/, file);
  }
});

test('runtime code has no model-name references in code, tests or docs', async () => {
  for (const { file, text } of await scanned()) assert.doesNotMatch(text, new RegExp(['hai', 'ku'].join(''), 'i'), file);
});

test('runtime code has no absolute home directories', async () => {
  for (const { file, text } of await scanned()) assert.doesNotMatch(text, /\/home\/[a-z_][\w-]*|\/Users\/\w+/i, file);
});

test('runtime reuses lib/verdict.mjs instead of forking a verdict parser', async () => {
  const classify = (await runtimeOnly()).find((s) => s.file.endsWith('classify.mjs'));
  assert.match(classify.text, /from '\.\.\/\.\.\/lib\/verdict\.mjs'/);
  for (const { file, text } of await runtimeOnly()) assert.doesNotMatch(text, /===\s*'通过'|===\s*'打回'/, file);
});

async function withDenylist(callback) {
  const root = await mkdtemp(join(repo, '.hygiene-fixture-'));
  const outside = join(root, 'external');
  const repository = join(root, 'repository');
  await mkdir(outside);
  await mkdir(repository);
  const denylistPath = join(outside, 'names.json');
  const bytes = Buffer.from(JSON.stringify(['distinctive-node', 'common']));
  await writeFile(denylistPath, bytes);
  try {
    return await callback({
      repoRoot: repository,
      denylistPath,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('hygiene scanner distinguishes private/public IPs and safe versions', async () => {
  await withDenylist(async (config) => {
    const findings = await scanHygiene({
      ...config,
      entries: [{ source: 'release-notes', value: 'Version 2.4.1; endpoints 8.8.8.8 and 192.168.44.2' }],
    });
    assert.deepEqual(findings.map((item) => item.kind), ['private-ip']);
  });
});

test('hygiene scanner catches private hostnames in prose and path-like text plus names and home paths', async () => {
  await withDenylist(async (config) => {
    const findings = await scanHygiene({
      ...config,
      entries: [{ source: 'metadata', value: 'connect to buildbox.internal; see /var/lib/worker.lan/cache and distinctive-node/common' },
        { source: 'paths', value: '~/.config/tool and /home/example/cache' }],
    });
    assert.deepEqual(new Set(findings.map((item) => item.kind)), new Set(['private-hostname', 'denylisted-name', 'home-path']));
  });
});

test('hygiene scanner detects credentials, URL/base64 encodings, long lines, and binary payloads without echoing values', async () => {
  await withDenylist(async (config) => {
    const credential = 'token=SAFE_42_UPPER';
    const encoded = Buffer.from('password=OTHER_73_VALUE').toString('base64');
    const findings = await scanHygiene({
      ...config,
      entries: [
        { source: 'long-line', value: `${'x'.repeat(12000)} ${encodeURIComponent(credential)}` },
        { source: 'encoded', value: encoded },
        { source: 'binary', value: Buffer.concat([Buffer.from([0, 255, 1]), Buffer.from('api_key=BIN_99_SECRET'), Buffer.from([0, 8])]) },
      ],
    });
    assert.ok(findings.length >= 3);
    const serialized = JSON.stringify(findings);
    for (const value of [credential, 'SAFE_42_UPPER', 'OTHER_73_VALUE', 'BIN_99_SECRET']) assert.ok(!serialized.includes(value));
    assert.ok(findings.every((item) => Object.keys(item).sort().join(',') === 'kind,offset,source'));
  });
});

test('hygiene scanner fails closed for missing, in-repository, and changed denylist without exposing values', async () => {
  await withDenylist(async (config) => {
    const entries = [];
    await assert.rejects(scanHygiene({ ...config, entries, denylistPath: join(repo, 'private-value.json') }), (error) => {
      assert.equal(error.code, 'RT_HYGIENE_CONFIG');
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
    await assert.rejects(scanHygiene({ ...config, entries, expectedSha256: '0'.repeat(64) }), { code: 'RT_HYGIENE_CONFIG' });
    await assert.rejects(scanHygiene({ ...config, entries, denylistPath: join(repo, 'runtime') }), { code: 'RT_HYGIENE_CONFIG' });
    const inside = join(config.repoRoot, 'inside.json');
    await writeFile(inside, JSON.stringify(['private-value']));
    const insideHash = createHash('sha256').update(await readFile(inside)).digest('hex');
    await assert.rejects(scanHygiene({ ...config, entries, denylistPath: inside, expectedSha256: insideHash }), { code: 'RT_HYGIENE_CONFIG' });
  });
});
