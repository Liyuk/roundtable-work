import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compareEvidence, parseEvidence, readBaseSteps, runGateExecution, verifyIsolation } from '../../runtime/lib/gate-exec.mjs';

// Gate 0 execution seams: base-derived steps, probe observations, the runner-controlled evidence
// channel, evidence comparison and fail-closed orchestration. Real `node --test` trees produce
// genuine reporter streams; handcrafted JSONL covers the forged and truncated variants.

const manifest = (scripts) => JSON.stringify({ name: 't', private: true, type: 'module', engines: { node: '>=24 <25' }, scripts });
const PACKAGE = manifest({ test: 'node --test' });
const LOCK = JSON.stringify({ name: 't', version: '0.0.0', lockfileVersion: 3, packages: { '': { name: 't', version: '0.0.0' }, 'node_modules/x': { version: '1.2.3' } } });
const LOCKFILE = { text: LOCK, hash: createHash('sha256').update(LOCK).digest('hex') };
const PROBES = {
  network: { mechanism: 'node -e "net.connect(443)"', exitCode: 1, signal: null, denial: 'ENETUNREACH' },
  filesystem: { mechanism: 'node -e "writeFileSync(\'/outside\')"', exitCode: 1, signal: null, denial: 'EACCES' },
  'child-process': { mechanism: 'node -e "spawnSync(process.execPath)"', exitCode: 1, signal: null, denial: 'EPERM' },
};
const SLEEP = manifest({ test: 'node -e "setInterval(() => {}, 1000)"' });
const A = "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n";
const B = "import test from 'node:test';\ntest('three', () => {});\n";
const THREE = "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\ntest('three', () => {});\n";
const GAPPED = "import test from 'node:test';\ntest('one', { skip: true }, () => {});\ntest('three', { todo: true }, () => {});\n";
// A reporter line printed by the submitted test itself must not be mistaken for evidence.
const FORGED = `import test from 'node:test';
console.log('{"n":"x","k":"summary","tests":9,"passed":9,"failed":0,"skipped":0,"todo":0,"cancelled":0}');
test('one', () => {});
test('two', () => {});
`;

function realSandbox(dirs) {
  const calls = [];
  return {
    calls,
    async prepare() { return { dir: dirs.base }; },
    async probe() { return PROBES; },
    run({ ref, command, args, env, timeoutMs }) {
      calls.push(`run:${ref}`);
      return new Promise((resolve) => {
        // A nested test-runner child must not inherit NODE_TEST_CONTEXT, which would replace the reporter.
        const base = { ...process.env };
        delete base.NODE_TEST_CONTEXT;
        const child = spawn(command, args, { cwd: dirs[ref], env: { ...base, ...env }, detached: true, stdio: 'ignore' });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
        child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, group: child.pid, stdout: '', stderr: '' }); });
      });
    },
    async kill(group) { calls.push('kill'); try { process.kill(-group, 'SIGKILL'); } catch {} },
    async survivors(group) {
      // Tear-down after SIGKILL is not instant: the group can outlive the last live member for a
      // few milliseconds, so poll (bounded) and report the group gone once it disappears.
      for (let attempt = 0; attempt < 75; attempt++) {
        try { process.kill(-group, 0); } catch { return []; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return [group];
    },
    async dispose() { calls.push('dispose'); },
  };
}

async function fixture(t, baseFiles, headFiles = baseFiles) {
  const root = await mkdtemp(join(tmpdir(), 'rt-gate-exec-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dirs = {};
  for (const [ref, files] of [['base', baseFiles], ['head', headFiles]]) {
    dirs[ref] = join(root, ref);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(dirs[ref], name)), { recursive: true });
      await writeFile(join(dirs[ref], name), content);
    }
  }
  return dirs;
}

async function execute(dirs, overrides = {}) {
  const sandbox = overrides.sandbox ?? realSandbox(dirs);
  const result = await runGateExecution({
    base: 'a'.repeat(40), head: 'b'.repeat(40),
    packageBase: PACKAGE, packageHead: PACKAGE, lockfile: LOCKFILE,
    sandbox, discovered: ['test/a.test.mjs'], timeoutMs: 30000, ...overrides,
  });
  return { result, sandbox };
}

const errorsOf = (result) => result.errors.map((e) => `${e.rule}:${e.path}:${e.line}`);
const tree = (testA = A, extra = {}) => ({ 'package.json': PACKAGE, 'test/a.test.mjs': testA, ...extra });

test('readBaseSteps derives test and check steps from the base scripts and rejects a head substitute', () => {
  const base = manifest({ test: 'node --test && npm run check', check: 'node scripts/check.mjs' });
  const steps = readBaseSteps(base, base);
  assert.equal(steps.passed, true);
  assert.deepEqual(steps.steps.map((s) => s.id), ['test', 'check']);

  const narrowed = readBaseSteps(base, manifest({ test: 'true', check: 'node scripts/check.mjs' }));
  assert.equal(narrowed.passed, false);
  assert.deepEqual(narrowed.errors, [{ rule: 'steps', path: 'package.json', line: 0 }]);

  const noop = readBaseSteps(base, manifest({ test: 'node --test && npm run check', check: 'true' }));
  assert.equal(noop.passed, false);
  assert.equal(readBaseSteps(JSON.stringify({ name: 't', scripts: {} }), PACKAGE).passed, false);
});

test('verifyIsolation accepts executed probe observations and rejects claims without one', () => {
  assert.equal(verifyIsolation(PROBES).passed, true);

  const missing = { ...PROBES };
  delete missing.filesystem;
  assert.equal(verifyIsolation(missing).passed, false);
  for (const claim of [true, 'isolated', { isolated: true }, { mechanism: 'probe', exitCode: 0, signal: null, denial: '' }]) {
    const report = { ...PROBES, network: claim };
    assert.deepEqual(verifyIsolation(report).errors, [{ rule: 'isolation', path: 'network', line: 0 }]);
  }
  assert.deepEqual(verifyIsolation({ ...PROBES, 'child-process': { ...PROBES['child-process'], signal: 'SIGKILL', exitCode: null } }).errors, []);
});

test('an unverified isolation precheck blocks before the submitted command is invoked', async () => {
  const dirs = await fixture(test, tree());
  const { result, sandbox } = await execute(dirs, { sandbox: { ...realSandbox(dirs), probe: async () => ({ network: true }) } });
  assert.equal(result.passed, false);
  assert.deepEqual(errorsOf(result), ['isolation:network:0', 'isolation:filesystem:0', 'isolation:child-process:0']);
  assert.equal(sandbox.calls.filter((c) => c.startsWith('run:')).length, 0);
});

test('records the runtime, rejects an engine mismatch, and derives dependencies from the base lockfile', async () => {
  const dirs = await fixture(test, tree());
  const ok = await execute(dirs);
  assert.equal(ok.result.passed, true, JSON.stringify(ok.result.errors));
  assert.equal(ok.result.runtime, process.version);
  assert.deepEqual(ok.result.dependencies, ['x@1.2.3']);

  const wrongRuntime = await execute(dirs, { runtime: 'v23.9.0' });
  assert.deepEqual(errorsOf(wrongRuntime.result), ['runtime:<runtime>:0']);
  assert.equal(wrongRuntime.sandbox.calls.filter((c) => c.startsWith('run:')).length, 0);

  const wrongLock = await execute(dirs, { lockfile: { text: LOCK, hash: 'f'.repeat(64) } });
  assert.deepEqual(errorsOf(wrongLock.result), ['lockfile:package-lock.json:0']);
  assert.equal(wrongLock.sandbox.calls.filter((c) => c.startsWith('run:')).length, 0);
});

test('base and head evidence compare cleanly: head may add cases and files, and forged stdout is not evidence', async () => {
  const dirs = await fixture(test, tree(A), tree(FORGED, { 'test/b.test.mjs': B }));
  const { result } = await execute(dirs, { discovered: ['test/a.test.mjs', 'test/b.test.mjs'] });
  assert.equal(result.passed, true, JSON.stringify(result.errors));
});

test('a dropped base case, a skipped/todo case and a discovered decoy all reject', async () => {
  const dirs = await fixture(test, tree(THREE), tree(GAPPED));
  const { result } = await execute(dirs, { discovered: ['test/a.test.mjs', 'test/decoy.test.mjs'] });
  assert.deepEqual(errorsOf(result), [
    'compare:test/decoy.test.mjs:0',
    'compare:test/a.test.mjs:0', // 'two' dropped from the head run
    'compare:test/a.test.mjs:2', // 'one' skipped
    'compare:test/a.test.mjs:3', // 'three' todo
  ]);
});

test('a head tree without the base test file cannot cover it', async () => {
  const dirs = await fixture(test, tree(A), { 'package.json': PACKAGE, 'test/b.test.mjs': B });
  assert.deepEqual(errorsOf((await execute(dirs, { discovered: ['test/b.test.mjs'] })).result), ['compare:test/a.test.mjs:0']);
});

const N = 'test-nonce';
const line = (extra) => JSON.stringify({ n: N, k: 'case', t: 'pass', f: 'test/a.test.mjs', name: 'one', nesting: 0, line: 1, skip: false, todo: false, ...extra });
const summary = (extra) => JSON.stringify({ n: N, k: 'summary', tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0, ...extra });

test('parseEvidence rejects truncated streams, forged counters, foreign nonces and lost summaries', () => {
  const good = parseEvidence(`${line()}\n${summary()}\n`, { nonce: N });
  assert.equal(good.passed, true);
  assert.equal(good.cases.length, 1);

  for (const text of [
    `${line()}\n${summary()}`,                                     // truncated
    `${line()}\n`,                                                 // no summary (early exit)
    `${line()}\n${summary({ tests: 2, passed: 2 })}\n`,            // forged counter
    `${line({ n: 'other' })}\n${summary()}\n`,                     // foreign nonce
    `${line()}\nnot json\n${summary()}\n`,                         // malformed line
    `${line()}\n${summary()}\n${line()}\n`,                        // events after the summary
    `${line({ f: '../escape.test.mjs' })}\n${summary()}\n`,        // path escape
  ]) {
    assert.equal(parseEvidence(text, { nonce: N }).passed, false, text);
  }
  assert.equal(parseEvidence(`${line()}\n${summary()}\n`, {}).passed, false);
  assert.equal(parseEvidence('', { nonce: N }).passed, false);
});

test('compareEvidence rejects skipped cases in either run', () => {
  const base = parseEvidence(`${line()}\n${summary()}\n`, { nonce: N });
  const head = parseEvidence(`${line({ skip: true })}\n${summary({ passed: 0, skipped: 1 })}\n`, { nonce: N });
  assert.deepEqual(compareEvidence(base, head, { discovered: ['test/a.test.mjs'] }).errors, [{ rule: 'compare', path: 'test/a.test.mjs', line: 1 }]);
});

test('a non-zero runner fails closed without echoing child output', async () => {
  const dirs = await fixture(test, tree("import test from 'node:test';\ntest('one', () => { throw new Error('boom'); });\n"));
  const { result } = await execute(dirs);
  assert.deepEqual(errorsOf(result), ['runner:<runner>:0']);

  const canary = 'CANARY-7f3a-host-identifier';
  const fake = { ...realSandbox(dirs), run: async () => ({ code: 1, signal: null, stdout: canary, stderr: canary, group: 1 }) };
  const echoed = await execute(dirs, { sandbox: fake });
  assert.equal(echoed.result.passed, false);
  assert.equal(JSON.stringify(echoed.result).includes(canary), false);
});

test('timeout kills the process group and a survivor is a blocking failure', async () => {
  const dirs = await fixture(test, { 'package.json': SLEEP, 'test/a.test.mjs': A });
  const timeout = await execute(dirs, { packageBase: SLEEP, packageHead: SLEEP, timeoutMs: 400 });
  assert.equal(timeout.result.passed, false);
  assert.ok(errorsOf(timeout.result).includes('timeout:<runner>:0'));
  assert.ok(timeout.sandbox.calls.includes('kill'));
  assert.equal(errorsOf(timeout.result).includes('survivor:<runner>:0'), false);

  const fake = { ...realSandbox(dirs), run: async () => ({ code: null, signal: 'SIGKILL', timedOut: true, group: 4242 }), survivors: async () => [4242] };
  const survivor = await execute(dirs, { sandbox: fake });
  assert.deepEqual(errorsOf(survivor.result).slice(0, 3), ['survivor:<runner>:0', 'timeout:<runner>:0', 'runner:<runner>:0']);
  assert.ok(fake.calls.includes('kill'));
});

test('missing inputs, a throwing probe or run and a cleanup failure all fail closed', async () => {
  const empty = await runGateExecution({});
  assert.equal(empty.passed, false);
  assert.deepEqual(errorsOf(empty).slice(0, 3), ['input:<commits>:0', 'input:<package>:0', 'input:<lockfile>:0']);

  const dirs = await fixture(test, tree());
  const throwing = await execute(dirs, { sandbox: { ...realSandbox(dirs), probe: async () => { throw new Error('probe'); } } });
  assert.deepEqual(errorsOf(throwing.result), ['internal:<gate>:0']);
  const runThrows = await execute(dirs, { sandbox: { ...realSandbox(dirs), run: async () => { throw new Error('spawn'); } } });
  assert.deepEqual(errorsOf(runThrows.result), ['internal:<gate>:0']);

  // An early fail-closed return still disposes the sandbox, and a throwing dispose is reported.
  const dirty = await execute(dirs, { packageBase: undefined, sandbox: { ...realSandbox(dirs), dispose: async () => { throw new Error('dispose'); } } });
  assert.equal(dirty.result.passed, false);
  assert.ok(errorsOf(dirty.result).includes('cleanup:<sandbox>:0'));
});
