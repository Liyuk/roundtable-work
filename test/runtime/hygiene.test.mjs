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
    if (file === 'runtime/lib/worktree.mjs' || file === 'runtime/lib/accept.mjs' || file === 'runtime/lib/reviewer-session.mjs') {
      // The worktree lifecycle, the Gate 0 composition layer and the separate-process reviewer are the subprocess integrations; keep them argument-based and local.
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

async function withRawDenylist(names, callback) {
  const root = await mkdtemp(join(repo, '.hygiene-fixture-'));
  const outside = join(root, 'external');
  const repository = join(root, 'repository');
  await mkdir(outside);
  await mkdir(repository);
  const denylistPath = join(outside, 'names.json');
  const bytes = Buffer.from(JSON.stringify(names));
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

const withDenylist = (callback) => withRawDenylist(['distinctive-node', { name: 'common', common: true }, { name: 'common-host', common: true }], callback);

const kindsOf = async (config, value) => (await scanHygiene({ ...config, entries: [{ source: 'probe', value }] })).map((item) => item.kind);

test('hygiene scanner matches common denylisted names only in host context', async () => {
  await withDenylist(async (config) => {
    assert.deepEqual(await kindsOf(config, 'the common approach works well'), []);
    for (const value of ['user@common-host', 'https://common-host/example', 'common-host.internal', 'ssh common-host', 'scp backup.tgz common-host:/srv']) {
      assert.ok((await kindsOf(config, value)).includes('denylisted-name'), value);
    }
    assert.ok((await kindsOf(config, 'Deploy DISTINCTIVE-NODE now')).includes('denylisted-name'));
  });
});

test('hygiene scanner fails closed on unsupported denylist entry shapes', async () => {
  for (const names of [['ok', { name: 'common' }], [{ common: true }], [42], [{ name: 'x', common: 'yes' }], 'ok']) {
    await withRawDenylist(names, async (config) => {
      await assert.rejects(scanHygiene({ ...config, entries: [] }), { code: 'RT_HYGIENE_CONFIG' });
    });
  }
});

test('hygiene scanner allows loopback addresses and version-like IPs', async () => {
  await withDenylist(async (config) => {
    assert.deepEqual(await kindsOf(config, `listen on ${[127, 0, 0, 1].join('.')} and ${[127, 1, 2, 3].join('.')}`), []);
    assert.deepEqual(await kindsOf(config, `release v${[192, 168, 1, 1].join('.')} and commit @${[10, 1, 2, 3].join('.')}`), []);
  });
});

test('hygiene scanner covers home path variants and skips angle-bracket placeholders', async () => {
  await withDenylist(async (config) => {
    for (const value of [`see ${['', 'root', '.ssh', 'config'].join('/')}`, 'C:\\Users\\EXAMPLE\\.gitconfig', '~EXAMPLE/cache', '~/cache']) {
      assert.deepEqual(await kindsOf(config, value), ['home-path'], value);
    }
    for (const value of [['', 'home', '<vps>'].join('/'), 'C:\\Users\\<vps>', ['', 'root', '<vps>'].join('/')]) assert.deepEqual(await kindsOf(config, value), [], value);
  });
});

test('hygiene scanner does not treat .corp as a private host suffix', async () => {
  await withDenylist(async (config) => {
    assert.deepEqual(await kindsOf(config, 'see app.corp/docs'), []);
  });
});

test('hygiene scanner distinguishes private/public IPs and safe versions', async () => {
  await withDenylist(async (config) => {
    const findings = await scanHygiene({
      ...config,
      entries: [{ source: 'release-notes', value: `Version 2.4.1; endpoints ${[8, 8, 8, 8].join('.')} and ${[192, 168, 44, 2].join('.')}` }],
    });
    assert.deepEqual(findings.map((item) => item.kind), ['public-ip', 'private-ip']);
  });
});

test('hygiene scanner catches private hostnames in prose and path-like text plus names and home paths', async () => {
  await withDenylist(async (config) => {
    const findings = await scanHygiene({
      ...config,
      entries: [{ source: 'metadata', value: 'connect to buildbox.internal; see /var/lib/worker.lan/cache and distinctive-node/common' },
        { source: 'paths', value: `~/.config/tool and ${['', 'home', 'example', 'cache'].join('/')}` }],
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

test('hygiene scanner decodes encoded credentials despite isolated percent signs', async () => {
  await withDenylist(async (config) => {
    const findings = await scanHygiene({ ...config, entries: [{ source: 'probe', value: 'progress 100% then token%3DSAFE_42_UPPER' }] });
    assert.deepEqual(findings.map((item) => item.kind), ['credential']);
    assert.ok(!JSON.stringify(findings).includes('SAFE_42_UPPER'));
  });
});

test('hygiene scanner handles invalid UTF-8 percent encodings and still detects credentials', async () => {
  await withDenylist(async (config) => {
    for (const value of ['%FF', '%C3', '%E0%A4%A', Buffer.from([0x25, 0x46, 0x46])]) {
      assert.deepEqual(await kindsOf(config, value), []);
    }
    const findings = await scanHygiene({ ...config, entries: [{ source: 'probe', value: '%FF then token%3DSAFE_42_UPPER' }] });
    assert.deepEqual(findings.map((item) => item.kind), ['credential']);
    assert.ok(!JSON.stringify(findings).includes('SAFE_42_UPPER'));
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

test('finding labels never reveal submitted sensitive paths', async () => {
  await withDenylist(async (config) => {
    const secret = 'distinctive-node';
    const findings = await scanHygiene({ ...config, entries: [{ source: `src/${secret}/file`, value: secret }] });
    assert.ok(findings.length);
    assert.ok(!JSON.stringify(findings).includes(secret));
  });
});

test('detects credential forms without exposing them', async () => {
  await withDenylist(async (config) => {
    for (const value of [['gh', 'p_', 'FAKE'.repeat(10)].join(''), ['sk', '-', 'FAKE'.repeat(10)].join(''), ['-----BEGIN ', 'OPENSSH', ' PRIVATE KEY-----'].join(''), ['https://', 'FAKE:EXAMPLE', '@example.com'].join('')]) {
      const findings = await scanHygiene({ ...config, entries: [{ source: value, value }] });
      assert.ok(findings.some((item) => item.kind === 'credential'));
      assert.ok(!JSON.stringify(findings).includes(value));
    }
  });
});

test('detects non-allowlisted IPs and allows documentation and loopback', async () => {
  await withDenylist(async (config) => {
    for (const [value, kind] of [ [[8,8,8,8].join('.'), 'public-ip'], [[10,1,2,3].join('.'), 'private-ip'], [['2606','4700','','1111'].join(':'), 'public-ip'], [['fd12','','1234'].join(':'), 'private-ip'] ]) {
      assert.ok((await kindsOf(config, value)).includes(kind));
    }
    for (const value of [[192,0,2,1].join('.'), [198,51,100,2].join('.'), [203,0,113,3].join('.'), ['2001','db8','','1'].join(':'), ['', '', '1'].join(':'), ['', '', 'ffff', '7f00', '1'].join(':')]) {
      assert.deepEqual(await kindsOf(config, value), []);
    }
  });
});

test('detects short encoded credentials without flagging ordinary short words', async () => {
  await withDenylist(async (config) => {
    assert.ok((await kindsOf(config, Buffer.from('token=42').toString('base64'))).includes('credential'));
    assert.deepEqual(await kindsOf(config, 'ordinary prose and release notes'), []);
  });
});

test('matches distinctive names at domain label boundaries', async () => {
  await withDenylist(async (config) => {
    assert.ok((await kindsOf(config, ['distinctive-node', 'example', 'com'].join('.'))).includes('denylisted-name'));
    assert.deepEqual(await kindsOf(config, 'predistinctive-node-suffix'), []);
  });
});
