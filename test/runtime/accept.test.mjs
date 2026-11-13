import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rulePatchErrors, runGate0 } from '../../runtime/lib/accept.mjs';

// Gate 0 composition seams: real synthetic Git repositories provide the evidence, a fixture
// denylist outside the repository holds only fake names, and the injected sandbox writes
// trustworthy-looking runner evidence for both refs. Chinese fixture text uses \u escapes only.

const PACKAGE = JSON.stringify({ name: 't', private: true, type: 'module', engines: { node: '>=20' }, scripts: { test: 'node --test' } });
const LOCK = '{"name":"t","lockfileVersion":3,"packages":{}}';
const CASES = "import test from 'node:test';\ntest('one', () => {});\n";
const TREE = { 'package.json': PACKAGE, 'package-lock.json': LOCK, 'docs/guide.md': '# Guide\n\nOld text.\n', 'test/x.test.mjs': CASES };
const CLEAN = { 'docs/guide.md': '# Guide\n\nOld text.\nNew English sentence.\n', 'test/x.test.mjs': CASES + "test('two', () => {});\n" };
const SCOPES = ['docs/**', 'test/**'];
const NAME = 'FAKEHOST-alpha';
const SKIP = 'sk' + 'ip';
const TODO = 'to' + 'do';

const LABEL = '\u5ba1\u67e5\u7ed3\u8bba';
const PASS = '\u901a\u8fc7';
const REJECT = '\u6253\u56de';
const BLOCK = '\u963b\u585e';
const VERDICT = `${LABEL}\uff1a${PASS} | ${REJECT} | ${BLOCK}`;
const ZH_LINE = '\u8fd9\u662f\u4e00\u6bb5\u8bf4\u660e';

const PROBES = {
  network: { mechanism: 'node -e "net.connect(443)"', exitCode: 1, signal: null, denial: 'ENETUNREACH' },
  filesystem: { mechanism: 'node -e "writeFileSync(\'/outside\')"', exitCode: 1, signal: null, denial: 'EACCES' },
  'child-process': { mechanism: 'node -e "spawnSync(process.execPath)"', exitCode: 1, signal: null, denial: 'EPERM' },
};

function fakeSandbox() {
  const calls = [];
  return {
    calls,
    async prepare() {},
    async probe() { return PROBES; },
    async run({ ref, env }) {
      calls.push(ref);
      const reporter = /--test-reporter=(\S+)/.exec(env.NODE_OPTIONS)[1];
      const destination = /--test-reporter-destination=(\S+)/.exec(env.NODE_OPTIONS)[1];
      const nonce = /const nonce = '([0-9a-f]+)'/.exec(await readFile(reporter, 'utf8'))[1];
      const record = (entry) => `${JSON.stringify({ n: nonce, ...entry })}\n`;
      await writeFile(destination, record({ k: 'case', t: 'pass', f: 'test/x.test.mjs', name: 'one', nesting: 0, line: 1, [SKIP]: false, [TODO]: false })
        + record({ k: 'summary', tests: 1, passed: 1, failed: 0, [SKIP + 'ped']: 0, [TODO]: 0, cancelled: 0 }));
      return { code: 0, signal: null, timedOut: false, group: 1, stdout: '', stderr: '' };
    },
    async kill() {},
    async survivors() { return []; },
    async dispose() {},
  };
}

async function repo(t, head, { base = TREE, message = 'head' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'rt-accept-'));
  const outside = await mkdtemp(join(tmpdir(), 'rt-denylist-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('config', 'commit.gpgsign', 'false');
  const write = async (files) => {
    for (const [path, value] of Object.entries(files)) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, value);
    }
  };
  await write(base);
  git('add', '-A');
  git('commit', '-qm', 'base');
  const baseRef = git('rev-parse', 'HEAD').trim();
  await write(head);
  git('add', '-A');
  git('commit', '-qm', message);
  return { root, outside, baseRef, headRef: git('rev-parse', 'HEAD').trim() };
}

const options = (fx, extra = {}) => ({ root: fx.root, baseRef: fx.baseRef, headRef: fx.headRef, issue: { allowedPaths: SCOPES }, runtime: process.version, timeoutMs: 20000, ...extra });

async function denylist(fx, names = [NAME]) {
  const path = join(fx.outside, 'names.json');
  const bytes = Buffer.from(JSON.stringify(names));
  await writeFile(path, bytes);
  return { denylistPath: path, expectedSha256: createHash('sha256').update(bytes).digest('hex') };
}

test('a clean in-scope diff passes', async (t) => {
  const fx = await repo(t, CLEAN);
  const sandbox = fakeSandbox();
  const result = await runGate0(options(fx, { ...(await denylist(fx)), sandbox }));
  assert.equal(result.verdict, 'pass', JSON.stringify(result.errors));
  assert.equal(result.passed, true);
  assert.deepEqual(sandbox.calls, ['base', 'head']);
});

test('a reversed translation direction rejects without running tests', async (t) => {
  const fx = await repo(t, { 'docs/guide.md': `# Guide\n\n${ZH_LINE}\n` });
  const sandbox = fakeSandbox();
  const result = await runGate0(options(fx, { ...(await denylist(fx)), sandbox }));
  assert.equal(result.verdict, 'reject');
  assert.ok(result.errors.some((error) => error.rule === 'direction'));
  assert.deepEqual(sandbox.calls, []);
});

test('a removed frozen token and verdict line rejects', async (t) => {
  const base = { ...TREE, 'docs/card.md': `# Card\n\n- Status: \`done\`\n\n\`\`\`\n${VERDICT}\n\`\`\`\n` };
  const fx = await repo(t, { 'docs/card.md': '# Card\n\n- Status: pending\n' }, { base });
  const sandbox = fakeSandbox();
  const result = await runGate0(options(fx, { ...(await denylist(fx)), sandbox }));
  assert.equal(result.verdict, 'reject');
  assert.ok(result.errors.some((error) => error.rule === 'contract'));
  assert.deepEqual(sandbox.calls, []);
});

test('an out-of-scope path rejects without running tests', async (t) => {
  const fx = await repo(t, { 'src/extra.mjs': 'export const x = 1;\n' });
  const sandbox = fakeSandbox();
  const result = await runGate0(options(fx, { ...(await denylist(fx)), sandbox }));
  assert.equal(result.verdict, 'reject');
  assert.ok(result.errors.some((error) => error.rule === 'scope'));
  assert.deepEqual(sandbox.calls, []);
});

test('a host identifier in an added line rejects without echoing the value', async (t) => {
  const fx = await repo(t, { 'docs/guide.md': `# Guide\n\nOld text.\nSee https://${NAME}/ now.\n` });
  const result = await runGate0(options(fx, { ...(await denylist(fx)), sandbox: fakeSandbox() }));
  assert.equal(result.verdict, 'reject');
  assert.ok(result.errors.some((error) => error.rule === 'hygiene:denylisted-name'));
  assert.ok(!JSON.stringify(result).includes(NAME));
});

test('a host identifier in commit metadata rejects without echoing the value', async (t) => {
  const fx = await repo(t, CLEAN, { message: `contact ${NAME} for access` });
  const result = await runGate0(options(fx, { ...(await denylist(fx)), sandbox: fakeSandbox() }));
  assert.equal(result.verdict, 'reject');
  assert.deepEqual(result.errors.filter((error) => error.rule === 'hygiene:denylisted-name').map((error) => error.path), ['<commit>']);
  assert.ok(!JSON.stringify(result).includes(NAME));
});

test('a missing or untrusted denylist blocks', async (t) => {
  const fx = await repo(t, CLEAN);
  const result = await runGate0(options(fx, { denylistPath: join(fx.outside, 'absent.json'), expectedSha256: 'a'.repeat(64), sandbox: fakeSandbox() }));
  assert.equal(result.verdict, 'block');
  assert.ok(result.errors.some((error) => error.rule === 'hygiene:config'));
});

test('a missing sandbox blocks', async (t) => {
  const fx = await repo(t, CLEAN);
  const result = await runGate0(options(fx, await denylist(fx)));
  assert.equal(result.verdict, 'block');
});

test('sandbox and runner failures never pass and never throw', async (t) => {
  const fx = await repo(t, CLEAN);
  const list = await denylist(fx);
  const broken = { ...fakeSandbox(), async prepare() { throw new Error('boom'); } };
  const first = await runGate0(options(fx, { ...list, sandbox: broken }));
  assert.equal(first.verdict, 'block');

  const failing = { ...fakeSandbox(), async run() { return { code: 1, signal: null, timedOut: false, group: 1, stdout: '', stderr: '' }; } };
  const second = await runGate0(options(fx, { ...list, sandbox: failing }));
  assert.equal(second.verdict, 'reject');
  assert.ok(second.errors.some((error) => error.rule === 'runner'));
});

const RULE_SCOPES = { allowedPaths: ['runtime/lib/**', 'test/**'] };
const RULE = { rule: 'rule_patch:test_missing', path: '<diff>', line: 0 };

test('a rule patch with no changed test file is rejected; adding a test file clears it', async (t) => {
  const bare = await repo(t, { 'runtime/lib/rule.mjs': 'export const rule = 2;\n' });
  const rejected = await runGate0(options(bare, { ...(await denylist(bare)), issue: RULE_SCOPES, sandbox: fakeSandbox() }));
  assert.notEqual(rejected.verdict, 'pass');
  assert.ok(rejected.errors.some((error) => error.rule === RULE.rule));

  const tested = await repo(t, { 'runtime/lib/rule.mjs': 'export const rule = 2;\n', 'test/rule.test.mjs': "import test from 'node:test';\n" });
  const cleared = await runGate0(options(tested, { ...(await denylist(tested)), issue: RULE_SCOPES, sandbox: fakeSandbox() }));
  assert.ok(!cleared.errors.some((error) => error.rule === RULE.rule));
});

test('rulePatchErrors detects rule patches by metadata, commit trailer or rule-only paths', () => {
  const CITE = { rule: 'rule_patch:no_citation', path: '<diff>', line: 0 };
  const CITED = { prBody: 'Stall-Evidence: log line 12' };
  assert.deepEqual(rulePatchErrors({ changedPaths: ['docs/a.md'], metadata: { rulePatch: true } }), [RULE, CITE]);
  assert.deepEqual(rulePatchErrors({ changedPaths: ['docs/a.md'], commitMessages: ['fix\n\nRule-Patch: yes'] }), [RULE, CITE]);
  assert.deepEqual(rulePatchErrors({ changedPaths: ['runtime/lib/a.mjs', '.roundtable/policy.md'] }), [RULE, CITE]);
  assert.deepEqual(rulePatchErrors({ changedPaths: ['runtime/lib/a.mjs', 'test/a.test.mjs'], metadata: { rulePatch: true } }), [CITE]);
  assert.deepEqual(rulePatchErrors({ changedPaths: ['runtime/lib/a.mjs', 'test/a.test.mjs'], metadata: { rulePatch: true, ...CITED } }), []);
  assert.deepEqual(rulePatchErrors({ changedPaths: ['docs/a.md'], metadata: { rulePatch: true, prBody: 'Stall-Evidence:' } }), [RULE, CITE]);
  assert.deepEqual(rulePatchErrors({ changedPaths: ['docs/a.md'] }), []);
});
