import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateDiffPolicy } from '../../runtime/lib/diff-policy.mjs';

// Synthetic Git repositories produce realistic raw evidence; handcrafted buffers cover the
// malformed cases Git never emits. Chinese fixture text is written with \u escapes only.

const LABEL = '\u5ba1\u67e5\u7ed3\u8bba';
const PASS = '\u901a\u8fc7';
const REJECT = '\u6253\u56de';
const BLOCK = '\u963b\u585e';
const VERDICT = `${LABEL}\uff1a${PASS} | ${REJECT} | ${BLOCK}`;
const ZH_A = '\u8fd9\u662f\u4e00\u6bb5\u8bf4\u660e';
const ZH_C = '\u8fd9\u662f\u4e00\u6bb5\u6587\u5b57';
const ZH_OTHER = '\u53e6\u4e00\u6bb5\u8bf4\u660e';

const SCOPES = ['docs/**', 'test/**', '.roundtable/**'];
const MAX = 64 * 1024 * 1024;

async function writeFiles(dir, files) {
  for (const [path, value] of Object.entries(files)) {
    const target = join(dir, path);
    if (value && typeof value === 'object' && value.remove) { await rm(target, { force: true }); continue; }
    await mkdir(dirname(target), { recursive: true });
    if (value && typeof value === 'object' && value.link) { await symlink(value.link, target); continue; }
    if (value && typeof value === 'object' && value.exec !== undefined) { await writeFile(target, value.exec); await chmod(target, 0o755); continue; }
    await writeFile(target, value);
  }
}

async function fixture(t, baseFiles, headFiles) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-diff-policy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  await writeFiles(dir, baseFiles);
  git('add', '-A');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  await writeFiles(dir, headFiles);
  git('add', '-A');
  git('commit', '-qm', 'head');
  const head = git('rev-parse', 'HEAD').trim();
  const evidence = execFileSync(
    'git',
    ['-C', dir, 'diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--find-copies', '--find-copies-harder', base, head, '--'],
    { maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const oids = new Set();
  for (const header of evidence.toString('latin1').split('\0')) {
    if (!header.startsWith(':')) continue;
    const [, , oldOid, newOid] = header.slice(1).split(' ');
    for (const oid of [oldOid, newOid]) if (oid && !/^0+$/.test(oid)) oids.add(oid);
  }
  const blobs = new Map();
  for (const oid of oids) {
    try { blobs.set(oid, execFileSync('git', ['-C', dir, 'cat-file', 'blob', oid], { maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'] })); } catch { /* gitlink */ }
  }
  return { base, head, evidence, blobs };
}

const doc = ({ body = 'Old guidance.', verdict = `\`\`\`\n${VERDICT}\n\`\`\`` } = {}) => [
  '# Notes',
  '',
  '`continue` and `wait` are continuation words.',
  '',
  verdict,
  '',
  'Owner: <person>',
  '',
  body,
  '',
].join('\n');

const cleanBase = { 'docs/notes.md': doc(), 'test/notes.test.mjs': "import test from 'node:test';\n\ntest('ok', () => {});\n" };
const cleanHead = { 'docs/notes.md': doc({ body: 'New guidance.' }) };

const call = (repo, overrides = {}) => validateDiffPolicy({
  base: repo.base,
  head: repo.head,
  evidence: repo.evidence,
  blobs: repo.blobs,
  allowedPaths: SCOPES,
  allow: {},
  baseline: {},
  ...overrides,
});

const rejected = (result, rule) => {
  assert.equal(result.passed, false, `expected rejection, got ${JSON.stringify(result.errors)}`);
  if (rule) assert.ok(result.errors.some((e) => e.rule === rule), `expected rule ${rule}: ${JSON.stringify(result.errors)}`);
};

const accepted = (result) => assert.deepEqual(result, { passed: true, errors: [] });

const zero = '0'.repeat(40);
const oidA = 'a'.repeat(40);
const oidB = 'b'.repeat(40);
const raw = (records) => Buffer.from(`${records.join('\0')}\0`, 'utf8');
const blobId = (content) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');

// --- 1. pinned objects ------------------------------------------------------

test('clean in-scope English diff that preserves the contract passes', async (t) => {
  accepted(call(await fixture(t, cleanBase, cleanHead)));
});

test('abbreviated, uppercase and mixed-length commit ids fail closed', async (t) => {
  const repo = await fixture(t, cleanBase, cleanHead);
  rejected(call(repo, { base: repo.base.slice(0, 12) }), 'id');
  rejected(call(repo, { head: repo.head.slice(0, 12) }), 'id');
  rejected(call(repo, { head: repo.head.toUpperCase() }), 'id');
  rejected(call(repo, { head: `${repo.head}0` }), 'id');
});

// --- 2. evidence and Git objects -------------------------------------------

test('truncated evidence, malformed records and colliding paths fail closed', async (t) => {
  const repo = await fixture(t, cleanBase, cleanHead);
  rejected(call(repo, { evidence: repo.evidence.subarray(0, repo.evidence.length - 1) }), 'evidence');
  rejected(call(repo, { evidence: Buffer.from(':oops\0docs/notes.md\0') }), 'evidence');
  rejected(call(repo, { evidence: Buffer.from(':100644 100644 abcd\0docs/notes.md\0') }), 'evidence');
  rejected(call(repo, { evidence: Buffer.from(`${repo.evidence.toString('latin1')}extra`) }), 'evidence');
  const deletions = { deletions: true };
  rejected(call(repo, { allow: deletions, evidence: raw([
    `:100644 000000 ${oidA} ${zero} D`, 'docs/A.md',
    `:100644 000000 ${oidB} ${zero} D`, 'docs/a.md',
  ]) }), 'evidence');
  rejected(call(repo, { allow: deletions, evidence: raw([
    `:100644 000000 ${oidA} ${zero} D`, 'docs/same.md',
    `:100644 000000 ${oidB} ${zero} D`, 'docs/same.md',
  ]) }), 'evidence');
  rejected(call(repo, { allow: deletions, evidence: raw([`:100644 000000 ${oidA} ${zero} D`, '']) }), 'evidence');
  rejected(call(repo, { evidence: Buffer.from(`:100644 000000 ${oidA} ${zero} D\0docs/\xff.md\0`, 'latin1') }), 'evidence');
});

test('object id and status inconsistencies fail closed', async (t) => {
  const repo = await fixture(t, cleanBase, cleanHead);
  rejected(call(repo, { evidence: raw([`:100644 100644 ${oidA} ${oidB} A`, 'docs/a.md']), blobs: new Map() }), 'evidence');
  rejected(call(repo, { allow: { deletions: true }, evidence: raw([`:100644 000000 ${oidA} ${oidB} D`, 'docs/a.md']) }), 'evidence');
  rejected(call(repo, { evidence: raw([`:100644 100644 ${zero} ${oidB} M`, 'docs/a.md']), blobs: new Map() }), 'evidence');
});

// --- 3. path scope and special files --------------------------------------

test('out-of-scope paths fail; allowed scope passes', async (t) => {
  const repo = await fixture(t, { ...cleanBase, 'outside/notes.md': 'Old\n' }, { 'outside/notes.md': 'New\n' });
  rejected(call(repo), 'scope');
  accepted(call(repo, { allowedPaths: [...SCOPES, 'outside/**'] }));
});

test('rename requires both paths in scope and the renames flag', async (t) => {
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
  const repo = await fixture(t, { 'docs/move.md': body }, { 'docs/move.md': { remove: true }, 'docs/moved.md': body });
  rejected(call(repo), 'scope');
  rejected(call(repo, { allow: { renames: true }, allowedPaths: ['docs/moved.md'] }), 'scope');
  accepted(call(repo, { allow: { renames: true } }));
});

test('copy, deletion and mode change are rejected unless authorized', async (t) => {
  const body = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
  const copy = await fixture(t, { 'docs/copy.md': body }, { 'docs/copy-copy.md': body });
  rejected(call(copy), 'scope');
  accepted(call(copy, { allow: { copies: true } }));

  const deleted = await fixture(t, { 'docs/gone.md': 'Old\n' }, { 'docs/gone.md': { remove: true } });
  rejected(call(deleted), 'scope');
  accepted(call(deleted, { allow: { deletions: true } }));

  const mode = await fixture(t, { 'docs/run.md': 'Old\n' }, { 'docs/run.md': { exec: 'Old\n' } });
  rejected(call(mode), 'special');
  accepted(call(mode, { allow: { modeChanges: true } }));
});

test('symlink, submodule and binary changes are rejected unless authorized', async (t) => {
  const link = await fixture(t, { 'docs/target.md': 'Old\n' }, { 'docs/link.md': { link: 'target.md' } });
  rejected(call(link), 'special');
  accepted(call(link, { allow: { symlinks: true } }));

  const submodule = {
    base: oidA,
    head: oidB,
    evidence: raw([`:000000 160000 ${zero} ${oidA} A`, 'docs/vendor-lib']),
    blobs: new Map(),
  };
  rejected(call(submodule), 'special');
  accepted(call(submodule, { allow: { submodules: true } }));

  const binary = await fixture(t, { 'docs/data.bin': Buffer.from([1, 2]) }, { 'docs/data.bin': Buffer.from([0, 1, 2]) });
  rejected(call(binary), 'special');
  accepted(call(binary, { allow: { binaries: true } }));
});

// --- 4. unsafe paths -------------------------------------------------------

test('absolute, traversal and control-character paths fail closed', async (t) => {
  const repo = await fixture(t, cleanBase, cleanHead);
  const deletion = (path) => raw([`:100644 000000 ${oidA} ${zero} D`, path]);
  const allow = { deletions: true };
  rejected(call(repo, { evidence: deletion('../evil.md'), allow }), 'scope');
  rejected(call(repo, { evidence: deletion('/etc/passwd'), allow }), 'scope');
  rejected(call(repo, { evidence: deletion('docs/a\u0001b.md'), allow }), 'scope');
  rejected(call(repo, { evidence: deletion('docs/.git/config'), allow }), 'scope');
  rejected(call(repo, { evidence: deletion('C:/evil.md'), allow }), 'scope');
  rejected(call(repo, { evidence: deletion('docs\\evil.md'), allow }), 'scope');
  rejected(call(repo, { evidence: deletion('docs/trailing.'), allow }), 'scope');
  rejected(call(repo, { evidence: deletion('docs/trailing '), allow }), 'scope');
});

// --- 5. direction ---------------------------------------------------------

test('a reversed line in an otherwise correct file fails', async (t) => {
  const repo = await fixture(t, cleanBase, { 'docs/notes.md': doc({ body: ZH_A }) });
  rejected(call(repo), 'direction');
});

test('removing Chinese and adding English passes', async (t) => {
  const repo = await fixture(t, { 'docs/zh.md': `${ZH_A}\n${ZH_OTHER}\n` }, { 'docs/zh.md': 'English only.\n' });
  accepted(call(repo));
});

test('a partial flip among correct files fails', async (t) => {
  const repo = await fixture(t, { ...cleanBase, 'docs/other.md': 'Old\n' }, {
    'docs/notes.md': doc({ body: 'New guidance.' }),
    'docs/other.md': `${ZH_OTHER}\n`,
  });
  const result = call(repo);
  rejected(result, 'direction');
  assert.ok(result.errors.some((e) => e.path === 'docs/other.md'));
});

test('literal, escaped, entity and percent-encoded CJK in added lines fail', async (t) => {
  const variants = {
    literal: `note: ${ZH_A}`,
    unicode: 'note: \\u8fd9\\u662f\\u4e00\\u6bb5\\u8bf4\\u660e',
    hexBytes: 'note: \\xE8\\xBF\\x99\\xE6\\x98\\xAF\\xE4\\xB8\\x80\\xE6\\xAE\\xB5\\xE8\\xAF\\xB4\\xE6\\x98\\x8E',
    htmlEntity: 'note: &#36825;&#26159;&#19968;&#27573;&#35828;&#26126;',
    percent: 'note: %E8%BF%99%E6%98%AF%E4%B8%80%E6%AE%B5%E8%AF%B4%E6%98%8E',
  };
  for (const line of Object.values(variants)) {
    rejected(call(await fixture(t, cleanBase, { 'docs/notes.md': doc({ body: line }) })), 'direction');
  }
});

// --- 6. base-side allowlists only ----------------------------------------

test('base-side CJK path allowlist permits allowlisted paths while the balance rule holds', async (t) => {
  const base = { 'docs/zh/guide.md': `# Guide\n\n${ZH_A}\n${ZH_OTHER}\n` };
  const baseline = { cjkPathAllowlist: ['docs/zh/**'] };

  const english = await fixture(t, base, { 'docs/zh/guide.md': `# Guide\n\n${ZH_A}\n${ZH_OTHER}\nEnglish line.\n` });
  accepted(call(english, { baseline }));

  const balanced = await fixture(t, base, { 'docs/zh/guide.md': `# Guide\n\n${ZH_C}\n${ZH_OTHER}\n` });
  accepted(call(balanced, { baseline }));

  const imbalanced = await fixture(t, base, { 'docs/zh/guide.md': `# Guide\n\n${ZH_A}\n${ZH_C}\n${ZH_OTHER}\n` });
  rejected(call(imbalanced, { baseline }), 'direction');

  const notAllowed = await fixture(t, base, { 'docs/zh/guide.md': `# Guide\n\n${ZH_A}\n${ZH_OTHER}\n${ZH_C}\n` });
  rejected(call(notAllowed), 'direction');
});

test('a head-side policy file cannot widen the base-side allowlist', async (t) => {
  const policyFile = JSON.stringify({ cjkPathAllowlist: ['docs/**'], markerAllowlist: ['todo'] }) + '\n';
  const repo = await fixture(t, cleanBase, {
    'docs/notes.md': doc({ body: `${ZH_A}\n// todo` }),
    '.roundtable/gate0-policy.json': policyFile,
  });
  const result = call(repo);
  rejected(result);
  assert.ok(result.errors.some((e) => e.rule === 'direction'));
  assert.ok(result.errors.some((e) => e.rule === 'marker'));
});

// --- 7. frozen machine contracts -----------------------------------------

test('removing or renaming a frozen token fails', async (t) => {
  const renamed = await fixture(t, cleanBase, {
    'docs/notes.md': doc().replace('`continue` and `wait` are continuation words.', '`continue` is a continuation word.'),
  });
  rejected(call(renamed), 'contract');

  const templates = [{ path: 'docs/notes.md', content: '- decision: continue/wait/ask/done/stop\n' }];
  const fieldBase = { 'docs/notes.md': `${doc()}- decision: continue\n` };
  const fieldHead = { 'docs/notes.md': `${doc()}- outcome: continue\n` };
  const field = await fixture(t, fieldBase, fieldHead);
  rejected(call(field, { baseline: { templates } }), 'contract');
});

test('moving the fenced verdict template to prose fails, a parenthetical passes', async (t) => {
  const camouflage = await fixture(t, cleanBase, { 'docs/notes.md': doc({ verdict: VERDICT }) });
  rejected(call(camouflage), 'contract');

  const parenthetical = await fixture(t, cleanBase, {
    'docs/notes.md': doc({ verdict: `\`\`\`\n${LABEL}\uff1a${PASS} (passed) | ${REJECT} | ${BLOCK}\n\`\`\`` }),
  });
  accepted(call(parenthetical));

  const nearMiss = await fixture(t, cleanBase, { 'docs/notes.md': `${doc()}See ${VERDICT} above.\n` });
  rejected(call(nearMiss), 'contract');
});

test('an inline backticked verdict template is a contract line, camouflage fails', async (t) => {
  const inline = (core = VERDICT, tail = '(Review verdict: pass | reject | block)') => `- first line \`${core}\` ${tail}`;
  const base = { 'docs/card.md': doc({ verdict: inline() }) };
  const head = (core = VERDICT, tail) => ({ 'docs/card.md': doc({ verdict: inline(core, tail), body: 'New guidance.' }) });

  accepted(call(await fixture(t, base, head())));
  accepted(call(await fixture(t, base, head(VERDICT, '(Review verdict: PASS | REJECT | BLOCK)'))));
  accepted(call(await fixture(t, base, head(`${LABEL}\uff1a${PASS} (pass) | ${REJECT} | ${BLOCK}`))));

  rejected(call(await fixture(t, base, head(`${LABEL}\uff1a${PASS} ${REJECT} ${BLOCK}`))), 'contract');
  rejected(call(await fixture(t, base, head(`${LABEL}\uff1a${REJECT} | ${PASS} | ${BLOCK}`))), 'contract');
  rejected(call(await fixture(t, base, head(`${LABEL}\uff1a${PASS} | ${REJECT}\` | \`${BLOCK}`))), 'contract');
});

test('a renamed per-file placeholder fails', async (t) => {
  const repo = await fixture(t, cleanBase, { 'docs/notes.md': doc().replace('Owner: <person>', 'Owner: <owner>') });
  rejected(call(repo), 'contract');
});

// --- 8. test-disabling markers -------------------------------------------

test('added skip, only, todo and xit forms fail in any file unless allowlisted', async (t) => {
  const added = ['.skip', '.only', 'todo', 'xit', 'skip:', 'only:', '{ skip', '{ only'];
  for (const form of added) {
    const line = form.startsWith('.') ? `test${form}('later', () => {});` : form === 'todo' ? '`todo`' : form === 'xit' ? 'xit(`later`, () => {});' : `${form} true }`;
    const repo = await fixture(t, cleanBase, { 'docs/notes.md': `${doc()}${line}\n` });
    rejected(call(repo), 'marker');
  }
});

test('a base-side marker allowlist permits an explicitly listed form', async (t) => {
  const repo = await fixture(t, cleanBase, { 'docs/notes.md': `${doc()}// todo: later\n` });
  rejected(call(repo), 'marker');
  accepted(call(repo, { baseline: { markerAllowlist: ['todo: later'] } }));
});

test('unchanged existing markers are not added lines', async (t) => {
  const base = {
    ...cleanBase,
    'test/notes.test.mjs': "import test from 'node:test';\n\ntest.skip('legacy', () => {});\ntest('ok', () => {});\n",
  };
  const head = {
    'docs/notes.md': doc({ body: 'New guidance.' }),
    'test/notes.test.mjs': "import test from 'node:test';\n\ntest.skip('legacy', () => {});\ntest('ok', () => {});\ntest('more', () => {});\n",
  };
  accepted(call(await fixture(t, base, head)));
});

// --- 9. independence -----------------------------------------------------

test('fixtures and policy calls are independent', async (t) => {
  const first = await fixture(t, cleanBase, cleanHead);
  const second = await fixture(t, { 'docs/zh/guide.md': `# Guide\n\n${ZH_A}\n` }, { 'docs/zh/guide.md': `# Guide\n\n${ZH_C}\n` });
  assert.notEqual(first.head, second.head);
  accepted(call(first));
  rejected(call(second), 'direction');
  accepted(call(second, { baseline: { cjkPathAllowlist: ['docs/zh/**'] } }));
  accepted(call(first));
});
