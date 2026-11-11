import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runGate0, buildRegistry, deriveVerdictTokens, deriveTemplateTokens, countToken, countCjk,
  stripFrozenCjk, globToRegExp, matchesAny, buildRunnerEnv, resolveTestSteps, nodeSatisfies,
  formatResult, isTestFile, countTestCases, BASELINE_PATH, stripNonCode, verifyDepsDir,
  deriveSharedPromptTokens,
} from '../../runtime/lib/accept.mjs';
import { hashText } from '../../runtime/lib/hygiene.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..');

// ---------------------------------------------------------------------------
// Fixture vocabulary. CJK characters are written as escapes (source stays ASCII).
// ---------------------------------------------------------------------------
const PASS = '\u901a\u8fc7';
const REJ = '\u6253\u56de';
const BLK = '\u963b\u585e';
const DONE = '\u5b8c\u6210';
const PART = '\u90e8\u5206\u5b8c\u6210';
const FAILED = '\u5931\u8d25';
const UNK = '\u672a\u77e5';
const LABEL = '\u5ba1\u67e5\u7ed3\u8bba';
const COLON = '\uff1a';
const ARTIFACT = '\u4ea7\u7269';
const EXECUTED = '\u5df2\u6267\u884c';
const PROSE_ZH = '\u8fd9\u4e2a\u6a21\u5757\u8d1f\u8d23\u68c0\u67e5\u6bcf\u6b21\u4ea4\u4ed8';
const PROSE_ZH_2 = '\u8bf7\u5148\u9605\u8bfb\u4efb\u52a1\u5361\u518d\u5f00\u59cb\u5de5\u4f5c';
const VERDICT_LINE = `${LABEL}${COLON}${PASS} | ${REJ} | ${BLK}`;

// Sensitive-looking strings are assembled at runtime so no literal exists in source.
const ip = (...p) => p.join('.');
const PRIVATE_IP = ip('10', '0', '0', '5');
const DOC_IP = ip('192', '0', '2', '10');
// A four-part version number (looks like a dotted quad); built from pieces on purpose.
const V4 = ip('1', '2', '3', '4');
const HOME_PATH = '/ho' + 'me/' + 'someone';
// A common OS image name is listed as a common-word host name; built from pieces on purpose.
const OS_IMAGE = ['ubu', 'ntu'].join('');
const FIXTURE_DENY = {
  hostnames: { distinctive: ['fixturehost-example'], common: [OS_IMAGE, 'toolbox'] },
  usernames: { distinctive: ['fixtureuser-example'], common: ['builder'] },
};
const SECRET = ['gh', 'p_', 'Zk3pQ9vL2xR7tW5yB8nM4cD6fH1jK0aS'].join('');

const BASE_PACKAGE = JSON.stringify({
  scripts: { test: 'node --test && npm run check', check: 'node scripts/check.mjs' },
  engines: { node: '>=24 <25' },
});

const TEMPLATE_DELIVERY = [
  '# Delivery / Review Card',
  '',
  '- Ticket / assignment / attempt / target version:',
  `- Status: ${DONE} | ${PART} | ${FAILED} | ${BLK} | ${UNK} (the reviewer writes as the first line \`${VERDICT_LINE}\`)`,
  `- ${ARTIFACT} (Artifacts), changes or PR links:`,
  'Fill <ticket ID> and <title> here.',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// Diff builders
// ---------------------------------------------------------------------------
function lineDiff(baseText, headText) {
  const b = baseText === '' ? [] : baseText.split('\n');
  const h = headText === '' ? [] : headText.split('\n');
  const pool = new Map();
  for (const l of b) pool.set(l, (pool.get(l) || 0) + 1);
  const added = [];
  h.forEach((text, i) => {
    if (pool.get(text) > 0) pool.set(text, pool.get(text) - 1);
    else added.push({ line: i + 1, text });
  });
  const hp = new Map();
  for (const l of h) hp.set(l, (hp.get(l) || 0) + 1);
  const removed = [];
  b.forEach((text, i) => {
    if (hp.get(text) > 0) hp.set(text, hp.get(text) - 1);
    else removed.push({ line: i + 1, text });
  });
  return { added, removed };
}

function edit(path, baseContent, headContent, extra = {}) {
  return {
    status: 'M', path, oldMode: '100644', newMode: '100644', binary: false,
    baseContent, headContent, ...lineDiff(baseContent, headContent), ...extra,
  };
}
const addFile = (path, content, extra = {}) => edit(path, '', content, { status: 'A', oldMode: '000000', ...extra });
const delFile = (path, content, extra = {}) => edit(path, content, '', { status: 'D', newMode: '000000', ...extra });

const OK_RUNNER = async () => ({ exitCode: 0 });
const DOCS_ISSUE = { allowedPaths: ['docs/**', 'README.md'] };

function run(files, over = {}) {
  return runGate0({
    diff: { files, base: { packageJson: BASE_PACKAGE, templates: [{ path: 'templates/delivery.md', content: TEMPLATE_DELIVERY }] } },
    issue: DOCS_ISSUE,
    metadata: { commitMessages: ['Translate docs'], authors: ['Fixture Author <author@example.com>'], prTitle: 'Translate docs', prBody: 'Docs only.', branch: 'rt/28-fixture' },
    denylist: FIXTURE_DENY,
    runner: OK_RUNNER,
    ...over,
  });
}
const ruleIds = (r) => [...new Set(r.findings.map((f) => f.ruleId))].sort();

// ---------------------------------------------------------------------------
// Acceptance fixtures
// ---------------------------------------------------------------------------

test('in-scope, tests-passing, direction-correct, invariant-preserving diff passes', async () => {
  const base = `# Guide\n${PROSE_ZH}\n${PROSE_ZH_2}\nStatus ${PASS} | ${REJ} | ${BLK}\n`;
  const head = '# Guide\nThis module checks every delivery.\nRead the task card before you start.\n'
    + `Status ${PASS} | ${REJ} | ${BLK}\n`;
  const r = await run([edit('docs/guide.md', base, head)]);
  assert.deepEqual(r, { verdict: 'pass', findings: [], blocks: [] });
});

test('reversed-direction translation fails (regression for #21 / #12)', async () => {
  const base = '# Guide\nThis module checks every delivery.\nRead the task card first.\n';
  const head = `# Guide\n${PROSE_ZH}\n${PROSE_ZH_2}\n`;
  const r = await run([edit('docs/guide.md', base, head)]);
  assert.equal(r.verdict, 'reject');
  assert.deepEqual(ruleIds(r), ['G0-LANG-BALANCE', 'G0-LANG-CJK']);
  assert.ok(r.findings.every((f) => f.path === 'docs/guide.md'));
});

test('partial flip: one file reversed among correct translations fails', async () => {
  const good = (name) => edit(`docs/${name}.md`, `${PROSE_ZH}\n`, 'This module checks every delivery.\n');
  const flipped = edit('docs/flipped.md', 'Read the task card first.\n', `${PROSE_ZH_2}\n`);
  const r = await run([good('a'), flipped, good('b')]);
  assert.equal(r.verdict, 'reject');
  assert.deepEqual([...new Set(r.findings.map((f) => f.path))], ['docs/flipped.md']);
});

test('a single flipped line inside an otherwise correct translation fails', async () => {
  const base = `${PROSE_ZH}\n${PROSE_ZH_2}\nPlain English line.\n`;
  const head = `This module checks every delivery.\nRead the task card first.\nPlain English line ${PROSE_ZH}.\n`;
  const r = await run([edit('docs/guide.md', base, head)]);
  assert.equal(r.verdict, 'reject');
  assert.ok(ruleIds(r).includes('G0-LANG-CJK'));
});

test('translating frozen machine fields, placeholders and enums fails (regression for #22 / #11)', async () => {
  const path = '.agents/skills/roundtable-work/templates/delivery.md';
  const issue = { allowedPaths: ['.agents/**'] };
  // (a) first line, status words, field label and placeholders translated to English.
  const head = [
    '# Delivery / Review Card',
    '',
    '- Ticket / assignment / attempt / target version:',
    '- Status: complete | partially complete | failed | blocked | unknown (the reviewer writes as the first line `Review verdict: pass | reject | block`)',
    '- Artifacts, changes or PR links:',
    'Fill <ticket id> and <name> here.',
    '',
  ].join('\n');
  const r = await run([edit(path, TEMPLATE_DELIVERY, head)], { issue });
  assert.equal(r.verdict, 'reject');
  for (const id of ['G0-TOKEN', 'G0-VERDICT-LINE']) assert.ok(ruleIds(r).includes(id), id);
  // (b) enum words renamed within English: no CJK involved, still fails.
  const enumBase = 'Ticket status: queued -> assigned -> working -> review -> ready -> done\n';
  const enumHead = 'Ticket status: pending -> assigned -> working -> review -> ready -> done\n';
  const r2 = await run([edit('docs/states.md', enumBase, enumHead)]);
  assert.equal(r2.verdict, 'reject');
  assert.deepEqual(ruleIds(r2), ['G0-TOKEN']);
  // (c) continuation words and aliases renamed.
  const r3 = await run([edit('docs/words.md', 'Use continue|wait|ask|done|stop.\nAlias returned.\n', 'Use go|wait|ask|done|stop.\nAlias sent_back.\n')]);
  assert.deepEqual(ruleIds(r3), ['G0-TOKEN']);
  // (d) Chinese status words translated to English.
  const r4 = await run([edit('docs/status.md', `Status: ${DONE} | ${FAILED}\n`, 'Status: complete | failed\n')]);
  assert.deepEqual(ruleIds(r4), ['G0-TOKEN']);
});

test('a frozen token that only gains an English parenthetical passes', async () => {
  const path = '.agents/skills/roundtable-work/templates/delivery.md';
  const head = TEMPLATE_DELIVERY
    .replace(`${PASS} | ${REJ} | ${BLK}\``, `${PASS} (pass) | ${REJ} (reject) | ${BLK} (block)\``)
    .replace(`- ${ARTIFACT} (Artifacts)`, `- ${ARTIFACT} (Artifacts, work products)`);
  assert.notEqual(head, TEMPLATE_DELIVERY);
  const r = await run([edit(path, TEMPLATE_DELIVERY, head)], { issue: { allowedPaths: ['.agents/**'] } });
  assert.deepEqual(r, { verdict: 'pass', findings: [], blocks: [] });
});

test('editing lib/verdict.mjs to rename an alias fails without explicit allowance', async () => {
  const source = readFileSync(join(repoRoot, 'lib', 'verdict.mjs'), 'utf8');
  const head = source.replaceAll("'returned'", "'sent_back'").replaceAll('alias: returned', 'alias: sent_back');
  assert.notEqual(head, source);
  const files = [edit('lib/verdict.mjs', source, head)];
  const r = await run(files, { issue: { allowedPaths: ['lib/**'] } });
  assert.equal(r.verdict, 'reject');
  assert.ok(ruleIds(r).includes('G0-SCOPE-PROTECTED'));
  // Even when the issue allows touching the file, the alias count still must not drop.
  const r2 = await run(files, { issue: { allowedPaths: ['lib/**'], allowChanges: { verdict: true } } });
  assert.equal(r2.verdict, 'reject');
  assert.deepEqual(ruleIds(r2), ['G0-TOKEN']);
});

test('out-of-scope path fails; renames need both paths in scope; deletions count', async () => {
  let r = await run([edit('scripts/tool.mjs', 'a\n', 'b\n')]);
  assert.deepEqual(ruleIds(r), ['G0-SCOPE-PATH']);

  const rename = (from, to) => edit(to, 'same\n', 'same\n', { status: 'R', oldPath: from });
  r = await run([rename('docs/a.md', 'scripts/a.md')]);
  assert.deepEqual(r.findings.map((f) => f.path), ['scripts/a.md']);
  r = await run([rename('scripts/a.md', 'docs/a.md')]);
  assert.deepEqual(r.findings.map((f) => f.path), ['scripts/a.md']);
  r = await run([rename('docs/a.md', 'docs/b.md')]);
  assert.equal(r.verdict, 'pass');

  r = await run([delFile('scripts/old.mjs', 'x\n')]);
  assert.deepEqual(ruleIds(r), ['G0-SCOPE-PATH']);
});

test('symlinks, submodules and binaries are rejected unless allowed', async () => {
  const link = edit('docs/link', '', '', { status: 'A', newMode: '120000' });
  const sub = edit('docs/sub', '', '', { status: 'A', newMode: '160000' });
  const bin = edit('docs/pic.png', '', '', { status: 'A', binary: true });
  for (const [file, flag] of [[link, 'symlinks'], [sub, 'submodules'], [bin, 'binaries']]) {
    let r = await run([file]);
    assert.deepEqual(ruleIds(r), ['G0-SCOPE-SPECIAL'], flag);
    r = await run([file], { issue: { ...DOCS_ISSUE, allowChanges: { [flag]: true } } });
    assert.equal(r.verdict, 'pass', flag);
  }
});

test('protected paths (gate0, allowlists, CI, lockfiles) are out of scope unless allowed', async () => {
  const broad = { allowedPaths: ['**'] };
  const paths = ['runtime/lib/accept.mjs', 'test/runtime/accept.test.mjs', BASELINE_PATH, '.github/workflows/ci.yml', 'package-lock.json', 'package.json'];
  for (const p of paths) {
    const r = await run([edit(p, 'a\n', 'b\n')], { issue: broad });
    assert.deepEqual(ruleIds(r), ['G0-SCOPE-PROTECTED'], p);
  }
  const allowed = { allowedPaths: ['runtime/lib/accept.mjs'], allowChanges: { gate0: true } };
  assert.equal((await run([edit('runtime/lib/accept.mjs', 'a\n', 'b\n')], { issue: allowed })).verdict, 'pass');
  // An allowChanges flag does not widen allowedPaths.
  assert.deepEqual(ruleIds(await run([edit('runtime/lib/other.mjs', 'a\n', 'b\n')], { issue: allowed })), ['G0-SCOPE-PATH']);
});

test('failing tests fail Gate 0; a runner timeout or crash blocks', async () => {
  const files = [edit('docs/a.md', 'a\n', 'b\n')];
  let r = await run(files, { runner: async () => ({ exitCode: 1 }) });
  assert.equal(r.verdict, 'reject');
  assert.deepEqual(ruleIds(r), ['G0-TESTS']);
  r = await run(files, { runner: async () => ({ exitCode: null, timedOut: true }) });
  assert.deepEqual(r.blocks, [{ ruleId: 'G0-TIMEOUT' }]);
  r = await run(files, { runner: () => new Promise(() => {}), runnerTimeoutMs: 30 });
  assert.deepEqual(r.blocks, [{ ruleId: 'G0-TIMEOUT' }]);
  r = await run(files, { runner: async () => ({}) });
  assert.deepEqual(r.blocks, [{ ruleId: 'G0-RUNNER' }]);
});

const T = ['te', 'st'].join('');
const testSource = (n, extra = '') => Array.from({ length: n }, (_, i) => `${T}('case ${i}', () => {});`).join('\n') + `\n${extra}`;

test('deleting tests or adding skip/only markers alongside message rewrites fails', async () => {
  const issue = { allowedPaths: ['test/**', 'docs/**'] };
  const msgBase = `// ${PROSE_ZH}\n${testSource(3)}`;
  const msgHead = `// This module checks every delivery.\n${testSource(3)}`;
  // Message rewrite alone passes.
  assert.equal((await run([edit('test/a.test.mjs', msgBase, msgHead)], { issue })).verdict, 'pass');
  // Deleting a test case while rewriting messages fails.
  let r = await run([edit('test/a.test.mjs', msgBase, `// This module checks every delivery.\n${testSource(2)}`)], { issue });
  assert.deepEqual(ruleIds(r), ['G0-TEST-COUNT']);
  // Deleting a whole test file fails.
  r = await run([delFile('test/b.test.mjs', testSource(2))], { issue });
  assert.deepEqual(ruleIds(r), ['G0-TEST-COUNT']);
  // Markers that disable or focus test cases in added lines fail.
  const markers = [`${T}.${'sk'}ip('x', () => {});`, `${T}.${'on'}ly('x', () => {});`, `${T}.${'to'}do('x');`, `${'x'}it('x', () => {});`];
  for (const marker of markers) {
    const head = `// This module checks every delivery.\n${testSource(3, marker)}`;
    r = await run([edit('test/a.test.mjs', msgBase, head)], { issue });
    assert.deepEqual(ruleIds(r), ['G0-TEST-SKIP'], marker);
    // The issue may allow it explicitly.
    r = await run([edit('test/a.test.mjs', msgBase, head)], { issue: { ...issue, allowSkip: true } });
    assert.equal(r.verdict, 'pass', marker);
  }
  // Tests may be removed only when the issue says so.
  r = await run([delFile('test/b.test.mjs', testSource(2))], { issue: { ...issue, allowChanges: { tests: true } } });
  assert.equal(r.verdict, 'pass');
});

test('option-form skip and only markers in added test lines fail unless allowed', async () => {
  const issue = { allowedPaths: ['test/**'] };
  const base = testSource(2);
  const forms = [
    `${T}('x', { ${'sk'}ip: true }, () => {});`,
    `${T}('x', { ${'on'}ly: true }, () => {});`,
    `${T}('x', {${'on'}ly:true}, () => {});`,
    `${T}('x', { ${'sk'}ip }, () => {});`,
    `const opts = { ${'sk'}ip : 'later' };`,
  ];
  for (const form of forms) {
    let r = await run([edit('test/a.test.mjs', base, `${base}\n${form}\n`)], { issue });
    assert.deepEqual(ruleIds(r), ['G0-TEST-SKIP'], form);
    r = await run([edit('test/a.test.mjs', base, `${base}\n${form}\n`)], { issue: { ...issue, allowSkip: true } });
    assert.equal(r.verdict, 'pass', form);
  }
  // Word boundary: ordinary words that merely contain the letters do not match.
  const ok = `${T}('x', { timeout: 5, ${'sk'}ipped: 1, only_these: 2 }, () => {});`;
  assert.equal((await run([edit('test/a.test.mjs', base, `${base}\n${ok}\n`)], { issue })).verdict, 'pass');
});

test('head package.json test no-op is ignored: the base command still runs; scope change fails unless allowed', async () => {
  const headPackage = JSON.stringify({ scripts: { test: 'true' }, engines: { node: '>=24 <25' } });
  const seen = [];
  const runner = async (spec) => { seen.push(spec.command); return { exitCode: 0 }; };
  const files = [edit('package.json', BASE_PACKAGE, headPackage)];
  let r = await run(files, { runner, issue: { allowedPaths: ['package.json'] } });
  assert.deepEqual(ruleIds(r), ['G0-SCOPE-PROTECTED']);
  assert.deepEqual(seen, ['node --test && npm run check']);

  seen.length = 0;
  r = await run(files, { runner, issue: { allowedPaths: ['package.json'], allowChanges: { packageJson: true } } });
  assert.equal(r.verdict, 'pass');
  assert.deepEqual(seen, ['node --test && npm run check']);

  // A failing base command still fails even if the head script is a no-op.
  r = await run(files, { runner: async (spec) => ({ exitCode: spec.command === 'true' ? 0 : 1 }), issue: { allowedPaths: ['package.json'], allowChanges: { packageJson: true } } });
  assert.deepEqual(ruleIds(r), ['G0-TESTS']);

  // Lockfile and CI config changes fail scope as well.
  for (const p of ['package-lock.json', '.github/workflows/test.yml']) {
    r = await run([edit(p, 'a\n', 'b\n')], { issue: { allowedPaths: [p] } });
    assert.deepEqual(ruleIds(r), ['G0-SCOPE-PROTECTED'], p);
  }
});

test('CJK path allowlist is base-side only and cannot be extended by the diff', async () => {
  const base = { cjkPathAllowlist: ['docs/zh-fixtures/**'] };
  const files = [addFile('docs/zh-fixtures/p.md', `${PROSE_ZH}\n`)];
  assert.equal((await run(files, { baseline: base })).verdict, 'pass');
  // Not allowlisted on base: fails, even if the same diff adds an allowlist entry.
  const extend = edit(BASELINE_PATH, '{"cjkPathAllowlist":[]}\n', '{"cjkPathAllowlist":["docs/**"]}\n');
  const r = await run([addFile('docs/other.md', `${PROSE_ZH}\n`), extend], { baseline: { cjkPathAllowlist: [] }, issue: { allowedPaths: ['docs/**', BASELINE_PATH] } });
  assert.equal(r.verdict, 'reject');
  assert.ok(ruleIds(r).includes('G0-LANG-CJK'));
  assert.ok(ruleIds(r).includes('G0-SCOPE-PROTECTED'));
  // A path outside the allowlist is still checked.
  assert.equal((await run([addFile('docs/zh-other/p.md', `${PROSE_ZH}\n`)], { baseline: base })).verdict, 'reject');
});

// ---------------------------------------------------------------------------
// Hygiene (rules 5-6)
// ---------------------------------------------------------------------------

test('host IP, hostname, OS username and home path in the diff, commit message or PR body fail', async () => {
  const docs = (text) => [edit('docs/a.md', 'x\n', `x\n${text}\n`)];
  const cases = [
    ['diff ip', docs(`host ${PRIVATE_IP}`), {}],
    ['diff hostname', docs('ssh deploy@fixturehost-example'), {}],
    ['diff username', docs('owner fixtureuser-example'), {}],
    ['diff home path', docs(`cd ${HOME_PATH}/repo`), {}],
    ['commit message', docs('ok'), { metadata: { commitMessages: [`Fix ${PRIVATE_IP}`] } }],
    ['pr body', docs('ok'), { metadata: { prBody: 'see\nfixturehost-example' } }],
    ['author', docs('ok'), { metadata: { authors: ['fixtureuser-example <a@example.com>'] } }],
    ['added path', [addFile('docs/fixturehost-example.md', 'x\n')], {}],
  ];
  for (const [name, files, over] of cases) {
    const r = await run(files, over);
    assert.equal(r.verdict, 'reject', name);
    assert.ok(r.findings.some((f) => f.ruleId.startsWith('HYG-')), name);
  }
});

test('documentation IPs, CI runs-on images, a colliding audit-tool name and four-part semver pass', async () => {
  const text = [
    `use ${DOC_IP} for the example`,
    `  runs-on: ${OS_IMAGE}-latest`,
    `  runs-on: ${OS_IMAGE}-24.04`,
    'run the toolbox audit before release',
    `requires pkg@${V4} or v${V4}`,
  ].join('\n');
  const r = await run([edit('docs/a.md', 'x\n', `x\n${text}\n`), addFile('.github/workflows/ci.yml', `  runs-on: ${OS_IMAGE}-latest\n`)], {
    issue: { allowedPaths: ['docs/**', '.github/**'], allowChanges: { ci: true } },
  });
  assert.deepEqual(r, { verdict: 'pass', findings: [], blocks: [] });
});

test('reject output contains no matched secret or host identifier', async () => {
  const hostName = 'fixturehost-example';
  const files = [edit('docs/a.md', 'x\n', `x\nkey = ${SECRET}\nhost ${PRIVATE_IP}\nconnect ${hostName}\n`), addFile(`docs/${hostName}.md`, 'x\n')];
  const r = await run(files, { metadata: { commitMessages: [`about ${hostName}`], prBody: `at ${HOME_PATH}/x` } });
  assert.equal(r.verdict, 'reject');
  const outputs = [JSON.stringify(r), formatResult(r)];
  for (const out of outputs) {
    for (const secret of [SECRET, PRIVATE_IP, hostName, HOME_PATH, 'someone']) {
      assert.ok(!out.includes(secret), `output leaked a sensitive string (${secret.length} chars)`);
    }
  }
  assert.ok(r.findings.every((f) => Object.keys(f).sort().join() === 'hash,length,line,path,ruleId'));
  assert.ok(r.findings.some((f) => f.ruleId === 'HYG-CRED'));
  assert.ok(r.findings.some((f) => /^<path:[0-9a-f]{8}>$/.test(f.path)));
});

test('a base-side testFakes allowlist exempts the exact location only', async () => {
  const fake = `key = ${SECRET}`;
  const probe = await run([edit('docs/a.md', 'x\n', `x\n${fake}\n`)]);
  const hit = probe.findings.find((f) => f.ruleId === 'HYG-CRED');
  assert.ok(hit);
  const baseline = { testFakes: [{ path: 'docs/a.md', hash: hit.hash }] };
  assert.equal((await run([edit('docs/a.md', 'x\n', `x\n${fake}\n`)], { baseline })).verdict, 'pass');
  assert.equal((await run([edit('docs/b.md', 'x\n', `x\n${fake}\n`)], { baseline })).verdict, 'reject');
});

// ---------------------------------------------------------------------------
// Fail-closed (rule 7)
// ---------------------------------------------------------------------------

test('a host run without a denylist blocks; with the fixture denylist it proceeds', async () => {
  const files = [edit('docs/a.md', 'a\n', 'b\n')];
  const noList = await run(files, { hostRun: true, networkIsolated: true, denylist: undefined, env: {} });
  assert.equal(noList.verdict, 'block');
  assert.deepEqual(noList.blocks, [{ ruleId: 'G0-DENYLIST' }]);
  const ok = await run(files, { hostRun: true, networkIsolated: true, env: {} });
  assert.equal(ok.verdict, 'pass');
  const empty = await run(files, { hostRun: true, networkIsolated: true, denylist: { hostnames: {}, usernames: {} }, env: {} });
  assert.deepEqual(empty.blocks, [{ ruleId: 'G0-DENYLIST' }]);
});

test('a host run that does not assert network isolation blocks', async () => {
  const r = await run([edit('docs/a.md', 'a\n', 'b\n')], { hostRun: true, env: {} });
  assert.deepEqual(r.blocks, [{ ruleId: 'G0-NETWORK' }]);
});

test('an internal error blocks and its message never reaches the output', async () => {
  const leak = 'fixturehost-example ' + PRIVATE_IP;
  const r = await run([edit('docs/a.md', 'a\n', 'b\n')], { runner: async () => { throw new Error(leak); } });
  assert.equal(r.verdict, 'block');
  assert.deepEqual(r.blocks, [{ ruleId: 'G0-INTERNAL' }]);
  assert.ok(!JSON.stringify(r).includes('fixturehost'));
  assert.ok(!formatResult(r).includes(PRIVATE_IP));
  // A malformed diff is an input failure, not a pass.
  const bad = await runGate0({ diff: { files: [{ path: 5 }] }, issue: DOCS_ISSUE, denylist: FIXTURE_DENY, runner: OK_RUNNER });
  assert.equal(bad.verdict, 'block');
});

test('missing required input blocks', async () => {
  const diff = { files: [], base: { packageJson: BASE_PACKAGE } };
  for (const opts of [
    {},
    { diff },
    { diff, issue: {} },
    { diff, issue: { allowedPaths: ['../x'] } },
    { diff, issue: DOCS_ISSUE },
    { diff: { files: [], base: {} }, issue: DOCS_ISSUE, runner: OK_RUNNER },
    { diff, issue: DOCS_ISSUE, runner: OK_RUNNER, timeoutMs: -1 },
    { root: '.', issue: DOCS_ISSUE },
  ]) {
    const r = await runGate0({ denylist: FIXTURE_DENY, ...opts });
    assert.equal(r.verdict, 'block', JSON.stringify(Object.keys(opts)));
    assert.ok(r.blocks.length >= 1);
  }
});

test('an overall timeout blocks', async () => {
  const r = await run([edit('docs/a.md', 'a\n', 'b\n')], { timeoutMs: 40, runner: () => new Promise(() => {}), runnerTimeoutMs: 60000 });
  assert.deepEqual(r.blocks, [{ ruleId: 'G0-TIMEOUT' }]);
});

test('a CPU-bound scan that outlives the timeout blocks instead of passing', async () => {
  const long = `aGVsbG8gd29ybGQ%41 token=abc ${V4} `.repeat(2000); // ~74 KB single line
  const head = `x\n${long}\n`;
  const r = await run([edit('docs/a.md', 'x\n', head)], { timeoutMs: 1 });
  assert.equal(r.verdict, 'block');
  assert.deepEqual(r.blocks, [{ ruleId: 'G0-TIMEOUT' }]);
  assert.deepEqual(r.findings, []);
  // A synchronous busy step (it blocks the event loop, so no timer can fire) is also over time.
  const busy = async () => { const end = Date.now() + 60; while (Date.now() < end) { /* spin */ } return { exitCode: 0 }; };
  const r2 = await run([edit('docs/a.md', 'a\n', 'b\n')], { timeoutMs: 20, runner: busy });
  assert.equal(r2.verdict, 'block');
  assert.deepEqual(r2.blocks, [{ ruleId: 'G0-TIMEOUT' }]);
  // The same step with a normal timeout passes.
  assert.equal((await run([edit('docs/a.md', 'a\n', 'b\n')], { timeoutMs: 60000, runner: busy })).verdict, 'pass');
});

test('a 50 KB line with a normal timeout finishes quickly and a secret inside it is still found', async () => {
  const pad = 'lorem ipsum '.repeat(4300); // ~52 KB
  const started = Date.now();
  const clean = await run([edit('docs/a.md', 'x\n', `x\n${pad}\n`)]);
  assert.equal(clean.verdict, 'pass');
  const dirty = await run([edit('docs/a.md', 'x\n', `x\n${pad} ${SECRET} ${pad} ${PRIVATE_IP}\n`)]);
  assert.equal(dirty.verdict, 'reject');
  assert.deepEqual(ruleIds(dirty), ['HYG-CRED', 'HYG-IP']);
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('a host run without PR metadata blocks; with metadata it proceeds; non-host runs are unchanged', async () => {
  const files = [edit('docs/a.md', 'a\n', 'b\n')];
  const host = { hostRun: true, networkIsolated: true, env: {} };
  for (const metadata of [{}, { prTitle: 'T', prBody: 'B' }, { prTitle: 'T', branch: 'rt/28-fixture' }, { prBody: 'B', branch: 'rt/28-fixture' }, { prTitle: 'T', prBody: 7, branch: 'rt/28-fixture' }]) {
    const r = await run(files, { ...host, metadata });
    assert.equal(r.verdict, 'block', JSON.stringify(Object.keys(metadata)));
    assert.deepEqual(r.blocks, [{ ruleId: 'G0-METADATA' }]);
  }
  const ok = await run(files, { ...host, metadata: { prTitle: 'T', prBody: '', branch: 'rt/28-fixture' } });
  assert.equal(ok.verdict, 'pass');
  assert.equal((await run(files, { metadata: {} })).verdict, 'pass');
});

test('Gate 0 can only reject or block, never approve: result verdicts are pass/reject/block', async () => {
  const r = await run([edit('docs/a.md', 'a\n', 'b\n')]);
  assert.ok(['pass', 'reject', 'block'].includes(r.verdict));
  assert.ok(!('approved' in r));
});

// ---------------------------------------------------------------------------
// Gate fix round: disable markers, counting, dependencies, registry
// ---------------------------------------------------------------------------

test('disable markers are checked on added lines of every non-Markdown file', async () => {
  const issue = { allowedPaths: ['test/**', 'lib/**', 'scripts/**', 'docs/**'] };
  const sk = `${T}.${'sk'}ip('x', () => {});`;
  const wordTodo = `// ${'to'}do: fix this later`;
  const cases = [
    ['helper outside tests', edit('lib/helper.mjs', 'export const a = 1;\n', `export const a = 1;\n${sk}\n`)],
    ['test fixture dir', edit('test/fixtures/util.mjs', 'export const a = 1;\n', `export const a = 1;\n${sk}\n`)],
    ['plain word in a source comment', edit('scripts/tool.mjs', 'a\n', `a\n${wordTodo}\n`)],
    ['x-prefixed case', edit('lib/helper.mjs', 'a\n', `a\n${'x'}it('x', () => {});\n`)],
    ['option form in config', edit('scripts/conf.json', '{}\n', `{ "${'on'}ly": true }\n`)],
    ['option form in code', edit('lib/helper.mjs', 'a\n', `a\nconst o = { ${'on'}ly: true };\n`)],
  ];
  for (const [name, file] of cases) {
    let r = await run([file], { issue });
    assert.deepEqual(ruleIds(r), ['G0-TEST-SKIP'], name);
    r = await run([file], { issue: { ...issue, allowSkip: true } });
    assert.equal(r.verdict, 'pass', name);
  }
  // A marker that is already in the base and not added is not flagged.
  const kept = edit('lib/helper.mjs', `${sk}\na\n`, `${sk}\nb\n`);
  assert.equal((await run([kept], { issue })).verdict, 'pass');
});

test('Markdown prose that uses the plain words is not rejected; dotted call forms are', async () => {
  const issue = { allowedPaths: ['docs/**', 'README.md'] };
  const prose = [
    `A ${'to'}do list for the release. We ${'sk'}ip nothing.`,
    `${'On'}ly: the owner may approve.`,
    `Use ${'x'}it only in tests.`,
  ].join('\n');
  for (const path of ['docs/notes.md', 'README.md', 'docs/NOTES.MD']) {
    assert.equal((await run([edit(path, 'x\n', `x\n${prose}\n`)], { issue })).verdict, 'pass', path);
  }
  for (const form of [`${T}.${'sk'}ip(`, `${T}.${'on'}ly(`, `describe.${'on'}ly (`.replace(' (', '(')]) {
    const file = edit('docs/notes.md', 'x\n', `x\nCall \`${form}'x')\` here.\n`);
    assert.deepEqual(ruleIds(await run([file], { issue })), ['G0-TEST-SKIP'], form);
    assert.equal((await run([file], { issue: { ...issue, allowSkip: true } })).verdict, 'pass', form);
  }
});

test('commented-out test calls are not counted, so disabling tests lowers the count', async () => {
  const issue = { allowedPaths: ['test/**'] };
  const base = testSource(3);
  // Commenting out a case and adding a comment copy of it does not keep the count.
  const head = `${testSource(2)}\n// ${T}('case 2', () => {});\n/* ${T}('case 3', () => {}); */\n`;
  let r = await run([edit('test/a.test.mjs', base, head)], { issue });
  assert.deepEqual(ruleIds(r), ['G0-TEST-COUNT']);
  // A normal test file whose comments mention the call keeps its count.
  const noisy = `${base}\n// the ${T}( helper wraps it( for you\n/* ${T}('x') */\n`;
  r = await run([edit('test/a.test.mjs', base, noisy)], { issue });
  assert.equal(r.verdict, 'pass');
  // The same noise on the base side must not inflate the base count either.
  r = await run([edit('test/a.test.mjs', noisy, `${testSource(3)}\n`)], { issue });
  assert.equal(r.verdict, 'pass');
  // Unit: strings, templates (code inside an expression still counts), regex literals and comments.
  const src = [
    `const s = "${T}(x)"; const t = 'it(y)';`,
    'const u = `' + T + '(z) ${' + T + "('real', f)}`;",
    `// ${T}(c)`,
    `/* it(c) */ ${T}('a', () => {});`,
    `const re = /${T}\\(/; const d = 4 / 2; ${T}('b', () => {});`,
  ].join('\n');
  assert.equal(countTestCases(src), 3);
  assert.equal(countTestCases(`${T}('a', () => {}); // ${T}('b')`), 1);
  assert.equal(stripNonCode("a = 'x // y'; b = 1; // c\n").includes('//'), false);
  assert.equal(stripNonCode('x /* a\nb */ y').split('\n').length, 2);
});

test('depsDir must carry the lockfile of the base', async () => {
  const lock = '{"lockfileVersion":3,"packages":{}}\n';
  const withDeps = JSON.stringify({ scripts: { test: 'node --test' }, engines: { node: '>=20' }, devDependencies: { 'pkg-example': '1.0.0' } });
  const tmpDirs = [];
  const depsWith = (content) => {
    const d = mkdtempSync(join(tmpdir(), 'gate0-deps-'));
    tmpDirs.push(d);
    if (content !== undefined) writeFileSync(join(d, 'package-lock.json'), content);
    return d;
  };
  const ran = [];
  const go = (depsDir, base) => runGate0({
    diff: { files: [edit('docs/a.md', 'a\n', 'b\n')], base: { templates: [], ...base } },
    issue: DOCS_ISSUE, denylist: FIXTURE_DENY, depsDir,
    runner: async () => { ran.push(1); return { exitCode: 0 }; },
  });
  try {
    const good = await go(depsWith(lock), { packageJson: withDeps, lockfile: lock });
    assert.deepEqual(good, { verdict: 'pass', findings: [], blocks: [] });
    assert.equal(ran.length, 1);
    ran.length = 0;
    const blocked = { verdict: 'block', findings: [], blocks: [{ ruleId: 'G0-DEPS' }] };
    // A different lockfile, no lockfile in the directory, no directory at all, an unreadable directory.
    assert.deepEqual(await go(depsWith(`${lock} `), { packageJson: withDeps, lockfile: lock }), blocked);
    assert.deepEqual(await go(depsWith(undefined), { packageJson: withDeps, lockfile: lock }), blocked);
    assert.deepEqual(await go(undefined, { packageJson: withDeps, lockfile: lock }), blocked);
    assert.deepEqual(await go(join(tmpdir(), 'gate0-no-such-deps-dir'), { packageJson: withDeps, lockfile: lock }), blocked);
    // Base declares dependencies but has no lockfile to compare against.
    assert.deepEqual(await go(depsWith(lock), { packageJson: withDeps }), blocked);
    // A lockfile on the base alone also requires a matching directory when one is supplied.
    assert.deepEqual(await go(depsWith(undefined), { packageJson: BASE_PACKAGE, lockfile: lock }), blocked);
    assert.equal(ran.length, 0, 'the runner must not start with unverified dependencies');
    // Nothing to verify: no dependencies and no lockfile on the base.
    assert.equal((await go(depsWith(undefined), { packageJson: BASE_PACKAGE })).verdict, 'pass');
    assert.equal((await go(undefined, { packageJson: BASE_PACKAGE })).verdict, 'pass');
    await assert.rejects(() => verifyDepsDir({ depsDir: depsWith('x'), baseLockfile: lock, hasDeps: true }), (e) => e.ruleId === 'G0-DEPS');
  } finally {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  }
});

test('frozen-token registry covers every template bullet, the shared prompt vocabulary and built-in names', async () => {
  const arrow = '\u2192';
  const tpl = [
    '# Card', '', '## Required', '- Ticket ID:', '', '## Fill as needed', '',
    '- Background facts: details', '- Budget (limits):', `- ${ARTIFACT} (Artifacts)`, '',
  ].join('\n');
  const shared = [
    '# Shared', '', '## Status Vocabulary (team)', '',
    `- **Delegation events**: \`sent ${arrow} delivered ${arrow} acknowledged\`; \`waiting_external\`.`,
    `- **Evidence level**: \`${EXECUTED}\` > \`${ARTIFACT}\``,
    '', '## Other', '', '- Mentions `outside_vocab` here.', '',
  ].join('\n');
  const reg = buildRegistry({ templates: [{ content: tpl }], sharedPrompt: shared });
  for (const t of ['Ticket ID', 'Background facts', 'Budget', ARTIFACT, 'sent', 'delivered', 'acknowledged', 'waiting_external', EXECUTED]) {
    assert.ok(reg.tokens.includes(t), t);
  }
  assert.ok(!reg.tokens.includes('outside_vocab'));
  assert.deepEqual(deriveSharedPromptTokens(shared).sort(), [ARTIFACT, EXECUTED, 'acknowledged', 'delivered', 'sent', 'waiting_external'].sort());
  assert.deepEqual(deriveSharedPromptTokens(undefined), []);

  const baseSide = { templates: [{ path: 'templates/card.md', content: tpl }], sharedPrompt: shared };
  const runBase = (files, over = {}) => run(files, {
    diff: { files, base: { packageJson: BASE_PACKAGE, ...baseSide } }, ...over,
  });
  // A machine field outside the old label set (a non-required heading) is renamed: fails.
  const doc = 'Background facts are listed here.\nThe budget: three attempts.\n';
  let r = await runBase([edit('docs/card.md', doc, doc.replace('Background facts', 'Context notes'))]);
  assert.deepEqual(ruleIds(r), ['G0-TOKEN']);
  // A delegation event word from the shared prompt vocabulary is renamed: fails.
  const events = 'Events: sent, delivered, acknowledged, started.\n';
  r = await runBase([edit('docs/events.md', events, events.replace('acknowledged', 'received'))]);
  assert.deepEqual(ruleIds(r), ['G0-TOKEN']);
  // A built-in default (evidence level) translated without keeping the original: fails.
  r = await runBase([edit('docs/evidence.md', `Level ${EXECUTED}\n`, 'Level executed\n')]);
  assert.deepEqual(ruleIds(r), ['G0-TOKEN']);
  // A backticked word outside the vocabulary section is not frozen.
  r = await runBase([edit('docs/other.md', 'Use outside_vocab here.\n', 'Use another_name here.\n')]);
  assert.equal(r.verdict, 'pass');
  // Correct direction still passes: the Chinese token is kept and a parenthetical is added.
  const zhBase = `- ${ARTIFACT}: ${PROSE_ZH}\nEvidence level ${EXECUTED}\nBackground facts: ${PROSE_ZH_2}\n`;
  const enHead = `- ${ARTIFACT} (Artifacts): This module checks every delivery.\nEvidence level ${EXECUTED} (executed)\nBackground facts: Read the task card first.\n`;
  r = await runBase([edit('docs/zh.md', zhBase, enHead)]);
  assert.deepEqual(r, { verdict: 'pass', findings: [], blocks: [] });
  // A base-side extra token supplied through the baseline is frozen as well.
  r = await runBase([edit('docs/x.md', 'The zzfield is set.\n', 'The renamedfield is set.\n')], { baseline: { frozenTokens: ['zzfield'] } });
  assert.deepEqual(ruleIds(r), ['G0-TOKEN']);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function countFirstLine(reg, text) { return (text.match(reg.verdictLine) || []).length; }

test('registry derives verdict forms from lib/verdict.mjs by probing parseVerdict', () => {
  const v = deriveVerdictTokens();
  for (const t of [PASS, REJ, BLK, 'passed', 'rejected', 'blocked', 'returned']) assert.ok(v.tokens.includes(t), t);
  assert.equal(v.chinese.passed, PASS);
  // Literals found in a (base-side) verdict source are probed too; unaccepted ones are dropped.
  const src = readFileSync(join(repoRoot, 'lib', 'verdict.mjs'), 'utf8');
  const v2 = deriveVerdictTokens(src);
  assert.ok(v2.tokens.every((t) => !/\s/.test(t)));
  const reg = buildRegistry({ templates: [{ path: 't.md', content: TEMPLATE_DELIVERY }], extras: ['extra-token'] });
  for (const t of ['queued', 'waiting_external', 'waiting_person', 'cancelled', DONE, PART, FAILED, UNK, LABEL,
    'continue', 'wait', 'ask', 'done', 'stop', ARTIFACT, '<ticket ID>', '<title>', 'extra-token']) {
    assert.ok(reg.tokens.includes(t), t);
  }
  assert.equal(countFirstLine(reg, VERDICT_LINE), 1);
  assert.equal(countFirstLine(reg, `${LABEL}${COLON}${PASS}|${REJ}|${BLK}`), 1);
  assert.equal(countFirstLine(reg, `${LABEL}${COLON}${PASS} (pass) | ${REJ} (reject) | ${BLK}`), 1);
  assert.equal(countFirstLine(reg, 'Review verdict: pass | reject | block'), 0);
});

test('template tokens: labels and placeholders from every heading', () => {
  const content = '## Required (x)\n\n- Ticket ID:\n- Result (details), more:\n\n## Fill as Needed\n\n- Background:\n- Notes (extra)\nuse <ticket ID>\n- A long prose bullet that is not a label, with words (and a note)\n';
  const tokens = deriveTemplateTokens([{ content }]);
  assert.deepEqual(tokens.sort(), ['<ticket ID>', 'Background', 'Notes', 'Result', 'Ticket ID']);
});

test('token counting is word-boundary and Chinese tokens ignore Han-adjacent prose', () => {
  assert.equal(countToken('done, done. abandoned undone', 'done'), 2);
  assert.equal(countToken('waiting_external waiting_external_x', 'waiting_external'), 1);
  assert.equal(countToken(`${PASS} | ${REJ} ${PASS}\u4ee5\u4e0b`, PASS), 1);
  assert.equal(countToken(`${PART} ${DONE}`, DONE), 1);
  assert.equal(countToken('<ticket ID> <ticket ID>', '<ticket ID>'), 2);
  assert.equal(countCjk(`a${PASS}b\u30ab\ud55c`), 4);
  const reg = buildRegistry({});
  assert.equal(stripFrozenCjk(`${PASS} | ${REJ} (pass)`, reg.tokens).trim().replace(/[ |]/g, ''), '(pass)');
  assert.ok(countCjk(stripFrozenCjk(`${PROSE_ZH} ${PASS}`, reg.tokens)) > 0);
});

test('kana and hangul count as CJK in added lines', async () => {
  for (const text of ['\u3042\u3044\u3046', '\ud55c\uad6d\uc5b4']) {
    const r = await run([addFile('docs/n.md', `${text}\n`)]);
    assert.ok(ruleIds(r).includes('G0-LANG-CJK'));
  }
});

test('halfwidth katakana and Han extension-B characters count as CJK and are rejected', async () => {
  for (const text of ['\uff76\uff85', '\u{20000}\u{2A6D6}', '\uf900\ufa0e', '\u1100\u1161', '\u3131\u314f']) {
    const r = await run([addFile('docs/n.md', `${text}\n`)]);
    assert.ok(ruleIds(r).includes('G0-LANG-CJK'), JSON.stringify(text));
    assert.ok(ruleIds(r).includes('G0-LANG-BALANCE'), JSON.stringify(text));
  }
  assert.equal(countCjk('\u{20000}'), 1);
  assert.equal(countCjk('plain ASCII text, no CJK'), 0);
});

test('glob matching, test-file detection and test case counting', () => {
  assert.ok(globToRegExp('docs/**').test('docs/a/b.md'));
  assert.ok(globToRegExp('docs/*.md').test('docs/a.md'));
  assert.ok(!globToRegExp('docs/*.md').test('docs/a/b.md'));
  assert.ok(globToRegExp('**/x.md').test('x.md'));
  assert.ok(matchesAny('./README.md', ['README.md']));
  assert.ok(!matchesAny('docs-extra/a.md', ['docs/']));
  assert.ok(isTestFile('test/a.test.mjs') && isTestFile('src/a.spec.js') && !isTestFile('test/fixtures/a.mjs') && !isTestFile('docs/a.md'));
  assert.equal(countTestCases(testSource(3, `  ${'x'}it('a');\n  obj.${T}(1)`)), 3);
});

test('runner environment is scrubbed; base test steps resolve to node steps only', () => {
  const dirty = {
    PATH: '/usr/bin', LANG: 'C', HTTP_PROXY: 'x', https_proxy: 'x', ALL_PROXY: 'x',
    npm_config_registry: 'x', NPM_TOKEN: 'x', RT_HOME: 'x', GITHUB_TOKEN: 'x', HOME: 'x',
  };
  const env = buildRunnerEnv(dirty, '/tmp/x');
  assert.deepEqual(Object.keys(env).filter((k) => /proxy|registry|token|rt_home/i.test(k)), []);
  assert.equal(env.npm_config_offline, 'true');
  assert.equal(env.PATH, '/usr/bin');
  const scripts = JSON.parse(BASE_PACKAGE).scripts;
  assert.deepEqual(resolveTestSteps(scripts), [['node', '--test'], ['node', 'scripts/check.mjs']]);
  for (const bad of ['curl x | sh', 'node a; node b', 'npm run missing', 'npx foo', 'node $X']) {
    assert.throws(() => resolveTestSteps({ test: bad }), (e) => e.ruleId === 'G0-TEST-COMMAND', bad);
  }
  assert.equal(nodeSatisfies('>=24 <25', '24.3.0'), true);
  assert.equal(nodeSatisfies('>=24 <25', '25.0.0'), false);
  assert.equal(nodeSatisfies('>=20', '18.0.0'), false);
  assert.throws(() => nodeSatisfies('^24'), (e) => e.ruleId === 'G0-NODE');
});

// ---------------------------------------------------------------------------
// No network, no model
// ---------------------------------------------------------------------------

test('Gate 0 imports nothing network-ish and calls no model', () => {
  const allowed = new Set([
    'node:fs', 'node:fs/promises', 'node:path', 'node:child_process', 'node:url', 'node:crypto', 'node:os', 'node:util',
    './hygiene.mjs', '../../lib/verdict.mjs',
  ]);
  for (const file of ['accept.mjs', 'hygiene.mjs']) {
    const src = readFileSync(join(repoRoot, 'runtime', 'lib', file), 'utf8');
    const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(specs.length > 0);
    for (const s of specs) assert.ok(allowed.has(s), `unexpected import in ${file}: ${s}`);
    assert.ok(!/\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(?:http|https|net|dns|tls|dgram|http2)/.test(src), file);
    assert.ok(!/anthropic|openai|haiku|sonnet|opus/i.test(src), file);
  }
});

test('source and tests are ASCII-only', () => {
  const files = [
    join(repoRoot, 'runtime', 'lib', 'accept.mjs'),
    join(repoRoot, 'test', 'runtime', 'accept.test.mjs'),
  ];
  for (const f of files) assert.ok(/^[\x00-\x7f]*$/.test(readFileSync(f, 'utf8')), f);
});

// ---------------------------------------------------------------------------
// Real git integration (temp repos under the OS temp dir)
// ---------------------------------------------------------------------------

const GIT_ENV = {
  PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'author@example.com',
};
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(baseFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'gate0-fixture-'));
  sh(dir, 'init', '-q', '-b', 'main');
  for (const [p, c] of Object.entries(baseFiles)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'checkout', '-q', '-b', 'rt/fixture');
  return dir;
}
function commitAll(dir, msg) {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', msg);
}

test('git mode: supplied commit messages and authors are additive and never hide real git metadata', async () => {
  const dir = makeRepo({ 'package.json': NODE_PACKAGE, 'run-tests.mjs': 'process.exit(0);\n', 'docs/a.md': 'a\n' });
  try {
    writeFileSync(join(dir, 'docs/a.md'), 'b\n');
    commitAll(dir, `Update, see ${PRIVATE_IP}`);
    writeFileSync(join(dir, 'docs/a.md'), 'c\n');
    sh(dir, 'add', '-A');
    sh(dir, 'commit', '-q', '-m', 'Clean follow-up', '--author', 'fixtureuser-example <writer@example.com>');
    const issue = { allowedPaths: ['docs/**'] };
    const common = { root: dir, baseRef: 'main', issue, denylist: FIXTURE_DENY, runner: OK_RUNNER };
    // Supplying a clean list does not hide the real commit message or the real author.
    const r = await runGate0({ ...common, metadata: { commitMessages: ['All clean'], authors: ['Fixture Author <author@example.com>'] } });
    assert.equal(r.verdict, 'reject');
    assert.ok(r.findings.some((f) => f.ruleId === 'HYG-IP' && f.path.startsWith('<metadata:commit#')));
    assert.ok(r.findings.some((f) => f.ruleId === 'HYG-USER' && f.path.startsWith('<metadata:author#')));
    assert.ok(!JSON.stringify(r).includes(PRIVATE_IP));
    // Supplied values are scanned as well (union), and malformed values block.
    const extra = await runGate0({ ...common, issue, metadata: { commitMessages: [`extra ${PRIVATE_IP}`] } });
    assert.ok(extra.findings.filter((f) => f.ruleId === 'HYG-IP').length >= 2);
    const bad = await runGate0({ ...common, metadata: { commitMessages: 'not-a-list' } });
    assert.deepEqual(bad.blocks, [{ ruleId: 'G0-INPUT' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function cliCaller(dir) {
  const cli = join(repoRoot, 'runtime', 'lib', 'accept.mjs');
  return (args, extraEnv = {}) => {
    try {
      const out = execFileSync(process.execPath, [cli, ...args], { cwd: dir, env: { PATH: process.env.PATH, ...extraEnv }, encoding: 'utf8' });
      return { code: 0, out };
    } catch (err) { return { code: err.status, out: String(err.stdout) }; }
  };
}

const NODE_PACKAGE = JSON.stringify({ scripts: { test: 'node run-tests.mjs' }, engines: { node: '>=20' } });

test('git mode: a Chinese->English translation in scope passes; rename, symlink and binary are caught', async () => {
  const dir = makeRepo({
    'package.json': NODE_PACKAGE,
    'run-tests.mjs': 'process.exit(0);\n',
    'docs/a.md': `# A\n${PROSE_ZH}\nStatus ${PASS} | ${REJ} | ${BLK}\n`,
    'docs/old.md': 'same\n',
    'lib/verdict.mjs': 'export const x = 1;\n',
  });
  try {
    writeFileSync(join(dir, 'docs/a.md'), `# A\nThis module checks every delivery.\nStatus ${PASS} | ${REJ} | ${BLK}\n`);
    commitAll(dir, 'Translate docs/a.md');
    const issue = { allowedPaths: ['docs/**'] };
    const common = { root: dir, baseRef: 'main', issue, denylist: FIXTURE_DENY, runner: OK_RUNNER, metadata: { prTitle: 'Translate', branch: 'rt/fixture' } };
    const ok = await runGate0(common);
    assert.deepEqual(ok, { verdict: 'pass', findings: [], blocks: [] });

    // Reverse the direction in git: now fails.
    writeFileSync(join(dir, 'docs/a.md'), `# A\n${PROSE_ZH}\n${PROSE_ZH_2}\nStatus ${PASS} | ${REJ} | ${BLK}\n`);
    commitAll(dir, 'Flip direction');
    const flipped = await runGate0(common);
    assert.equal(flipped.verdict, 'reject');
    assert.ok(ruleIds(flipped).includes('G0-LANG-CJK'));

    // Rename out of scope, symlink, binary, deletion of a protected file.
    sh(dir, 'mv', 'docs/old.md', 'scripts-old.md');
    symlinkSync('a.md', join(dir, 'docs/link.md'));
    writeFileSync(join(dir, 'docs/pic.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
    sh(dir, 'rm', '-q', 'lib/verdict.mjs');
    commitAll(dir, 'Misc');
    const bad = await runGate0(common);
    assert.equal(bad.verdict, 'reject');
    const byRule = (id) => bad.findings.filter((f) => f.ruleId === id).map((f) => f.path).sort();
    assert.ok(byRule('G0-SCOPE-PATH').includes('scripts-old.md'));
    assert.ok(byRule('G0-SCOPE-PATH').includes('lib/verdict.mjs'));
    assert.deepEqual(byRule('G0-SCOPE-SPECIAL'), ['docs/link.md', 'docs/pic.bin']);
    assert.ok(byRule('G0-SCOPE-PROTECTED').includes('lib/verdict.mjs'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git mode: commit messages are scanned; the default runner runs the BASE command', async () => {
  const dir = makeRepo({
    'package.json': NODE_PACKAGE,
    'run-tests.mjs': 'process.exit(0);\n',
    'docs/a.md': 'a\n',
  });
  try {
    // Head neuters the test script and breaks the real test file.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'true' }, engines: { node: '>=20' } }));
    writeFileSync(join(dir, 'run-tests.mjs'), 'process.exit(1);\n');
    writeFileSync(join(dir, 'docs/a.md'), `b ${PRIVATE_IP}\n`);
    commitAll(dir, `note about ${PRIVATE_IP}`);
    const r = await runGate0({
      root: dir, baseRef: 'main', denylist: FIXTURE_DENY,
      issue: { allowedPaths: ['docs/**', 'package.json', 'run-tests.mjs'] },
    });
    assert.equal(r.verdict, 'reject');
    for (const id of ['G0-TESTS', 'G0-SCOPE-PROTECTED', 'HYG-IP']) assert.ok(ruleIds(r).includes(id), id);
    assert.ok(r.findings.some((f) => f.path === '<metadata:commit#1>'));
    assert.ok(!JSON.stringify(r).includes(PRIVATE_IP));

    // With the test file fixed the base command passes through the default runner.
    writeFileSync(join(dir, 'run-tests.mjs'), 'process.exit(0);\n');
    writeFileSync(join(dir, 'docs/a.md'), 'b\n');
    sh(dir, 'commit', '-q', '--amend', '-a', '-m', 'clean message');
    const ok = await runGate0({
      root: dir, baseRef: 'main', denylist: FIXTURE_DENY,
      issue: { allowedPaths: ['docs/**', 'package.json', 'run-tests.mjs'], allowChanges: { packageJson: true } },
    });
    assert.deepEqual(ok, { verdict: 'pass', findings: [], blocks: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('git mode: the base-side allowlist file is read from base, and an unknown base ref blocks', async () => {
  const dir = makeRepo({
    'package.json': NODE_PACKAGE,
    'run-tests.mjs': 'process.exit(0);\n',
    [BASELINE_PATH]: JSON.stringify({ cjkPathAllowlist: ['docs/zh/**'] }),
  });
  try {
    mkdirSync(join(dir, 'docs/zh'), { recursive: true });
    writeFileSync(join(dir, 'docs/zh/p.md'), `${PROSE_ZH}\n`);
    commitAll(dir, 'Add bilingual parser fixture');
    const issue = { allowedPaths: ['docs/**'] };
    const r = await runGate0({ root: dir, baseRef: 'main', issue, denylist: FIXTURE_DENY, runner: OK_RUNNER });
    assert.equal(r.verdict, 'pass');
    // Widening the list inside the diff does not help.
    mkdirSync(join(dir, 'docs/other'), { recursive: true });
    writeFileSync(join(dir, 'docs/other/p.md'), `${PROSE_ZH}\n`);
    writeFileSync(join(dir, BASELINE_PATH), JSON.stringify({ cjkPathAllowlist: ['docs/**'] }));
    commitAll(dir, 'Widen allowlist');
    const r2 = await runGate0({ root: dir, baseRef: 'main', issue: { allowedPaths: ['docs/**', BASELINE_PATH] }, denylist: FIXTURE_DENY, runner: OK_RUNNER });
    assert.equal(r2.verdict, 'reject');
    assert.ok(ruleIds(r2).includes('G0-LANG-CJK'));
    assert.ok(ruleIds(r2).includes('G0-SCOPE-PROTECTED'));
    const r3 = await runGate0({ root: dir, baseRef: 'no-such-ref', issue, denylist: FIXTURE_DENY, runner: OK_RUNNER });
    assert.deepEqual(r3.blocks, [{ ruleId: 'G0-GIT' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 0 / 1 / 2 for pass / reject / block and prints redacted JSON (local mode)', () => {
  const dir = makeRepo({ 'package.json': NODE_PACKAGE, 'run-tests.mjs': 'process.exit(0);\n', 'docs/a.md': 'a\n' });
  try {
    writeFileSync(join(dir, 'docs/a.md'), 'b\n');
    commitAll(dir, 'Edit');
    writeFileSync(join(dir, 'issue.json'), JSON.stringify({ allowedPaths: ['docs/**'] }));
    const call = cliCaller(dir);
    const pass = call(['--local', '--root', dir, '--base', 'main', '--issue', join(dir, 'issue.json')]);
    assert.equal(pass.code, 0, pass.out);
    const parsed = JSON.parse(pass.out);
    assert.equal(parsed.verdict, 'pass');
    // Local runs are marked non-authoritative; the alias behaves the same.
    assert.equal(parsed.authoritative, false);
    assert.equal(parsed.mode, 'local');
    assert.equal(call(['--no-host-run', '--root', dir, '--base', 'main', '--issue', join(dir, 'issue.json')]).code, 0);
    writeFileSync(join(dir, 'issue.json'), JSON.stringify({ allowedPaths: ['other/**'] }));
    const reject = call(['--local', '--root', dir, '--base', 'main', '--issue', join(dir, 'issue.json')]);
    assert.equal(reject.code, 1);
    assert.equal(JSON.parse(reject.out).verdict, 'reject');
    const block = call(['--local', '--root', dir, '--base', 'main']);
    assert.equal(block.code, 2);
    assert.deepEqual(JSON.parse(block.out).blocks, [{ ruleId: 'G0-INPUT' }]);
    const hostBlock = call(['--root', dir, '--base', 'main', '--issue', join(dir, 'issue.json'), '--host-run']);
    assert.equal(hostBlock.code, 2);
    // Contradictory mode flags are an input error.
    assert.equal(call(['--local', '--host-run', '--root', dir, '--base', 'main', '--issue', join(dir, 'issue.json')]).code, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI defaults to production semantics: no denylist, no isolation assertion or no metadata blocks (exit 2)', () => {
  const dir = makeRepo({ 'package.json': NODE_PACKAGE, 'run-tests.mjs': 'process.exit(0);\n', 'docs/a.md': 'a\n' });
  try {
    writeFileSync(join(dir, 'docs/a.md'), 'b\n');
    commitAll(dir, 'Edit');
    const issue = join(dir, 'issue.json');
    writeFileSync(issue, JSON.stringify({ allowedPaths: ['docs/**'] }));
    const meta = join(dir, 'meta.json');
    writeFileSync(meta, JSON.stringify({ prTitle: 'Edit', prBody: 'Docs only.', branch: 'rt/fixture' }));
    const call = cliCaller(dir);
    const base = ['--root', dir, '--base', 'main', '--issue', issue];
    const ids = (r) => JSON.parse(r.out).blocks.map((b) => b.ruleId).sort();
    // Nothing supplied: every production requirement is reported.
    const bare = call(base);
    assert.equal(bare.code, 2);
    assert.deepEqual(ids(bare), ['G0-DENYLIST', 'G0-METADATA', 'G0-NETWORK']);
    assert.equal(JSON.parse(bare.out).authoritative, undefined);
    // Metadata and isolation asserted but no denylist under $RT_HOME: still a block.
    const noList = call([...base, '--metadata', meta, '--network-isolated']);
    assert.equal(noList.code, 2);
    assert.deepEqual(ids(noList), ['G0-DENYLIST']);
    // No isolation assertion.
    const home = join(dir, 'rt-home');
    mkdirSync(join(home, 'gate0'), { recursive: true });
    writeFileSync(join(home, 'gate0', 'denylist.json'), JSON.stringify(FIXTURE_DENY));
    const noNet = call([...base, '--metadata', meta], { RT_HOME: home });
    assert.equal(noNet.code, 2);
    assert.deepEqual(ids(noNet), ['G0-NETWORK']);
    // Everything supplied: runs the base command through the default runner and passes.
    const full = call([...base, '--metadata', meta, '--network-isolated'], { RT_HOME: home });
    assert.equal(full.code, 0, full.out);
    assert.deepEqual(JSON.parse(full.out), { verdict: 'pass', findings: [], blocks: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
