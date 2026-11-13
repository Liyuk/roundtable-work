import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Gate 0 test execution over a reviewed change. Steps, dependencies and the runtime range come from
// the base commit only; isolation is proven by executed probe observations; test evidence is written
// by a runner-controlled reporter to a private file, never by the submitted tests. Pure checks are
// separate from the orchestrator, which receives a sandbox provider as an injected side effect.
//
// Sandbox provider contract (the host supplies it):
//   prepare({ base, head }) -> { dir }            disposable sandbox containing both trees
//   probe({ ref }) -> observations                executed network/filesystem/child-process probes
//   run({ ref, command, args, env, timeoutMs }) -> { code, signal, timedOut, group, stdout, stderr }
//   kill(group)                                   kill the runner's process group
//   survivors(group) -> number[]                  live process ids left in that group
//   dispose()                                     remove the disposable sandbox
// `env` must be merged into the provider's base environment so NODE_OPTIONS reaches the runner.

const DIMENSIONS = ['network', 'filesystem', 'child-process'];
const REFS = ['base', 'head'];
const add = (errors, rule, path, line = 0) => errors.push({ rule, path, line });

const REPORTER = `import { relative } from 'node:path';
import { Transform } from 'node:stream';
const nonce = '__NONCE__';
const rel = (file) => (typeof file === 'string' ? relative(process.cwd(), file) : '');
export default function () {
  return new Transform({
    writableObjectMode: true,
    transform(event, _encoding, callback) {
      const data = event.data ?? {};
      if (event.type === 'test:pass' || event.type === 'test:fail') {
        this.push(JSON.stringify({ n: nonce, k: 'case', t: event.type === 'test:pass' ? 'pass' : 'fail', f: rel(data.file), name: data.name, nesting: data.nesting ?? 0, line: data.line ?? 0, skip: data.skip === true, todo: data.todo === true }) + '\\n');
      } else if (event.type === 'test:summary' && data.file === undefined && data.counts) {
        const counts = data.counts;
        this.push(JSON.stringify({ n: nonce, k: 'summary', tests: counts.tests, passed: counts.passed, failed: counts.failed, skipped: counts.skipped, todo: counts.todo, cancelled: counts.cancelled }) + '\\n');
      }
      callback();
    },
  });
}
`;

const parseVersion = (text) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return match ? match.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** True when `runtime` satisfies the base `engines` range (no range or a foreign syntax is a reject). */
function satisfies(range, runtime) {
  const version = parseVersion(runtime);
  if (!version || typeof range !== 'string') return false;
  return range.trim().split(/\s+/).every((part) => {
    const match = /^(>=|<=|>|<|\^|~|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(part);
    if (!match) return false;
    const op = match[1] ?? '=';
    const parts = [match[2], match[3], match[4]].map((value) => (value === undefined || value === 'x' || value === '*' ? null : Number(value)));
    const low = [parts[0], parts[1] ?? 0, parts[2] ?? 0];
    if (op === '>=') return compare(version, low) >= 0;
    if (op === '>') return compare(version, low) > 0;
    if (op === '<=') return compare(version, low) <= 0;
    if (op === '<') return compare(version, low) < 0;
    if (op === '^' || op === '~') {
      const high = op === '^'
        ? (low[0] > 0 ? [low[0] + 1, 0, 0] : parts[1] !== null ? [0, low[1] + 1, 0] : [0, 0, low[2] + 1])
        : [low[0], low[1] + 1, 0];
      return compare(version, low) >= 0 && compare(version, high) < 0;
    }
    return parts.every((part, index) => part === null || part === version[index]);
  });
}

/** Test and check steps from the base package.json; a different head script is a narrowed substitute. */
export function readBaseSteps(baseText, headText) {
  const errors = [];
  let base;
  let head;
  try { base = JSON.parse(baseText); head = JSON.parse(headText); }
  catch { add(errors, 'steps', 'package.json'); return { passed: false, errors, steps: [], engines: undefined }; }
  const scripts = base?.scripts ?? {};
  const headScripts = head?.scripts ?? {};
  const engines = base?.engines?.node;
  if (typeof scripts.test !== 'string' || scripts.test.trim() === '') {
    add(errors, 'steps', 'package.json');
    return { passed: false, errors, steps: [], engines };
  }
  const steps = [{ id: 'test', command: 'npm', args: ['test'] }];
  if (/\brun\s+check\b/.test(scripts.test)) {
    if (typeof scripts.check !== 'string' || scripts.check.trim() === '') add(errors, 'steps', 'package.json');
    else steps.push({ id: 'check', command: 'npm', args: ['run', 'check'] });
  }
  if (headScripts.test !== scripts.test) add(errors, 'steps', 'package.json');
  if (steps.length === 2 && headScripts.check !== scripts.check) add(errors, 'steps', 'package.json');
  return { passed: errors.length === 0, errors, steps, engines };
}

/** Base lockfile text pinned by its sha256; the dependency set is derived from the base lockfile. */
function readLockfile(lockfile) {
  const errors = [];
  if (!lockfile || typeof lockfile.text !== 'string' || lockfile.text === '' || typeof lockfile.hash !== 'string') {
    add(errors, 'input', '<lockfile>');
    return { errors, dependencies: [] };
  }
  if (createHash('sha256').update(lockfile.text).digest('hex') !== lockfile.hash) {
    add(errors, 'lockfile', 'package-lock.json');
    return { errors, dependencies: [] };
  }
  let parsed;
  try { parsed = JSON.parse(lockfile.text); } catch { add(errors, 'lockfile', 'package-lock.json'); return { errors, dependencies: [] }; }
  const dependencies = Object.entries(parsed?.packages ?? {})
    .filter(([path, entry]) => path !== '' && typeof entry?.version === 'string')
    .map(([path, entry]) => `${path.replace(/^.*node_modules\//, '')}@${entry.version}`)
    .sort();
  return { errors, dependencies };
}

const isSafePath = (path) => typeof path === 'string' && path !== '' && !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..');

/** Strict JSONL parse of the runner-controlled evidence channel. */
export function parseEvidence(text, { nonce, source = '<evidence>' } = {}) {
  const errors = [];
  const bad = (line) => add(errors, 'evidence', source, line);
  const cases = [];
  let declared;
  if (typeof nonce !== 'string' || nonce === '' || typeof text !== 'string' || text === '') {
    bad(0);
    return { passed: false, errors, cases, declared };
  }
  if (!text.endsWith('\n')) {
    bad(text.split('\n').length);
    return { passed: false, errors, cases, declared };
  }
  const lines = text.split('\n').slice(0, -1);
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    let entry;
    try { entry = JSON.parse(line); } catch { bad(number); break; }
    if (!entry || entry.n !== nonce) { bad(number); break; }
    if (entry.k === 'case') {
      const valid = isSafePath(entry.f) && typeof entry.name === 'string' && entry.name !== ''
        && Number.isInteger(entry.nesting) && entry.nesting >= 0 && Number.isInteger(entry.line) && entry.line >= 0
        && typeof entry.skip === 'boolean' && typeof entry.todo === 'boolean' && (entry.t === 'pass' || entry.t === 'fail');
      if (!valid) { bad(number); break; }
      cases.push({ file: entry.f, name: entry.name, line: entry.line, status: entry.t, skip: entry.skip, todo: entry.todo });
    } else if (entry.k === 'summary') {
      const keys = ['tests', 'passed', 'failed', 'skipped', 'todo', 'cancelled'];
      if (declared || !keys.every((key) => Number.isInteger(entry[key]) && entry[key] >= 0) || index !== lines.length - 1) { bad(number); break; }
      declared = Object.fromEntries(keys.map((key) => [key, entry[key]]));
    } else { bad(number); break; }
  }
  if (errors.length === 0 && !declared) bad(0);
  if (errors.length === 0) {
    const observed = {
      tests: cases.length,
      passed: cases.filter((entry) => entry.status === 'pass' && !entry.skip && !entry.todo).length,
      failed: cases.filter((entry) => entry.status === 'fail').length,
      skipped: cases.filter((entry) => entry.skip).length,
      todo: cases.filter((entry) => entry.todo).length,
      cancelled: 0,
    };
    for (const key of Object.keys(observed)) if (observed[key] !== declared[key]) add(errors, 'evidence', source, 0);
  }
  return { passed: errors.length === 0, errors, cases, declared };
}

/** Head may add files and cases, but may not drop base files/cases, skip cases, or omit discovered files. */
export function compareEvidence(base, head, { discovered } = {}) {
  const errors = [];
  const group = (parsed) => {
    const files = new Map();
    for (const entry of parsed.cases) {
      if (!files.has(entry.file)) files.set(entry.file, new Map());
      files.get(entry.file).set(entry.name, entry);
    }
    return files;
  };
  const baseFiles = group(base);
  const headFiles = group(head);
  for (const file of Array.isArray(discovered) ? discovered : []) if (!headFiles.has(file)) add(errors, 'compare', file);
  for (const [file, names] of baseFiles) {
    if (!headFiles.has(file)) { add(errors, 'compare', file); continue; }
    for (const name of names.keys()) if (!headFiles.get(file).has(name)) add(errors, 'compare', file);
  }
  for (const parsed of [base, head]) for (const entry of parsed.cases) if (entry.skip || entry.todo) add(errors, 'compare', entry.file, entry.line);
  return { passed: errors.length === 0, errors };
}

/** Every dimension needs an executed observation: mechanism, exit/signal and the denial seen. */
export function verifyIsolation(report) {
  const errors = [];
  for (const dimension of DIMENSIONS) {
    const probe = report?.[dimension];
    const observed = probe && typeof probe === 'object' && !Array.isArray(probe)
      && typeof probe.mechanism === 'string' && probe.mechanism !== ''
      && typeof probe.denial === 'string' && probe.denial !== ''
      && ((Number.isInteger(probe.exitCode) && probe.exitCode !== 0) || (typeof probe.signal === 'string' && probe.signal !== ''));
    if (!observed) add(errors, 'isolation', dimension);
  }
  return { passed: errors.length === 0, errors };
}

/**
 * Run the base-defined steps against base and head, prove isolation first, and compare the evidence.
 * The result is `{ passed, errors, runtime, dependencies }`; it never approves or merges anything.
 */
export async function runGateExecution(input = {}) {
  const { base, head, packageBase, packageHead, lockfile, runtime = process.version, sandbox, discovered, timeoutMs = 120000 } = input;
  const errors = [];
  const dependencies = [];
  let evidenceDir;
  try {
    if (typeof base !== 'string' || base === '' || typeof head !== 'string' || head === '') add(errors, 'input', '<commits>');
    if (typeof packageBase !== 'string' || typeof packageHead !== 'string') add(errors, 'input', '<package>');
    const lock = readLockfile(lockfile);
    errors.push(...lock.errors);
    dependencies.push(...lock.dependencies);
    const steps = errors.length ? { passed: false, errors: [], steps: [], engines: undefined } : readBaseSteps(packageBase, packageHead);
    errors.push(...steps.errors);
    if (steps.passed && !satisfies(steps.engines, runtime)) add(errors, 'runtime', '<runtime>');
    if (!sandbox || !['prepare', 'probe', 'run', 'kill', 'survivors', 'dispose'].every((method) => typeof sandbox[method] === 'function')) add(errors, 'input', '<sandbox>');
    if (!Array.isArray(discovered) || discovered.length === 0) add(errors, 'input', '<discovered>');
    if (errors.length) return { passed: false, errors, runtime, dependencies };

    await sandbox.prepare({ base, head });
    const isolation = verifyIsolation(await sandbox.probe({ ref: 'head' }));
    errors.push(...isolation.errors);
    if (errors.length) return { passed: false, errors, runtime, dependencies };

    evidenceDir = await mkdtemp(join(tmpdir(), 'rt-gate-exec-'));
    await chmod(evidenceDir, 0o700);
    const nonce = randomBytes(16).toString('hex');
    const reporter = join(evidenceDir, 'reporter.mjs');
    await writeFile(reporter, REPORTER.replace('__NONCE__', nonce));
    const parsed = {};
    for (const ref of REFS) {
      const destination = join(evidenceDir, `${ref}.jsonl`);
      const env = { NODE_OPTIONS: `--test-reporter=${reporter} --test-reporter-destination=${destination}` };
      for (const step of steps.steps) {
        const result = await sandbox.run({ ref, command: step.command, args: step.args, env, timeoutMs });
        if (result?.timedOut || result?.signal) {
          await sandbox.kill(result.group);
          if ((await sandbox.survivors(result.group)).length > 0) add(errors, 'survivor', '<runner>');
          if (result.timedOut) add(errors, 'timeout', '<runner>');
        }
        if (result?.timedOut || result?.signal || result?.code !== 0) { add(errors, 'runner', '<runner>'); break; }
      }
      if (errors.length) break;
      let text = '';
      try { text = await readFile(destination, 'utf8'); } catch { add(errors, 'evidence', ref); break; }
      parsed[ref] = parseEvidence(text, { nonce, source: ref });
      errors.push(...parsed[ref].errors);
      if (errors.length) break;
    }
    if (errors.length === 0) errors.push(...compareEvidence(parsed.base, parsed.head, { discovered }).errors);
  } catch {
    add(errors, 'internal', '<gate>');
  } finally {
    if (sandbox && typeof sandbox.dispose === 'function') { try { await sandbox.dispose(); } catch { add(errors, 'cleanup', '<sandbox>'); } }
    if (evidenceDir) { try { await rm(evidenceDir, { recursive: true, force: true }); } catch { add(errors, 'cleanup', '<evidence>'); } }
  }
  return { passed: errors.length === 0, errors, runtime, dependencies };
}
