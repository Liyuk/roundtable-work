import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { validateDiffPolicy } from './diff-policy.mjs';
import { scanHygiene } from './hygiene.mjs';
import { runGateExecution } from './gate-exec.mjs';

// Gate 0 composition layer. It collects the trusted git evidence once (argument-based execFile,
// no shell, pinned full SHAs) and composes the already-reviewed modules: the deterministic diff
// policy, the hygiene scan and the sandboxed test execution. Nothing from the reviewed HEAD is
// imported or executed here; base-side text is only read statically.
//
// Result: { verdict: 'pass' | 'reject' | 'block', passed, errors: [{ rule, path, line }] }.
// `pass` only when all three components pass. Missing input, malformed git evidence, a missing or
// untrusted denylist, a missing sandbox, an internal error and timeout/cleanup/isolation/evidence
// failures block; deterministic scope/direction/contract/marker/hygiene/test failures reject.
// Diagnostic paths never carry a matched secret or raw exception text.

const run = promisify(execFile);
const MAX_BUFFER = 16 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const TEMPLATES = '.agents/skills/roundtable-work/templates/';
const GIT_ENV = {
  LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0',
};
const GIT_FLAGS = ['--no-replace-objects', '--no-pager', '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false'];
const ALLOW_KEYS = ['deletions', 'renames', 'copies', 'modeChanges', 'symlinks', 'submodules', 'binaries'];
const BLOCK_POLICY = new Set(['evidence', 'id', 'blob']);
const BLOCK_EXEC = new Set(['input', 'sandbox', 'timeout', 'cleanup', 'isolation', 'evidence', 'internal', 'survivor']);
const TEST_PATH = /(?:^|\/)test\/.*\.[cm]?jsx?$|\.(?:test|spec)\.[cm]?jsx?$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OID = /^[0-9a-f]{40,64}$/;
const ZERO = /^0+$/;
const ZERO_MODE = '000000';
const GITLINK = '160000';
const SYMLINK = '120000';

async function git(root, args, { allowFail = false, timeoutMs = TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await run('git', [...GIT_FLAGS, '-C', root, ...args], {
      encoding: 'buffer', maxBuffer: MAX_BUFFER, timeout: timeoutMs, env: { PATH: process.env.PATH ?? '', ...GIT_ENV },
    });
    return stdout;
  } catch (error) {
    if (allowFail) return undefined;
    throw error;
  }
}
const gitText = async (root, args, options) => (await git(root, args, options))?.toString('utf8');

async function resolve(root, ref, timeoutMs) {
  const sha = (await gitText(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], { timeoutMs }))?.trim();
  if (!COMMIT.test(sha ?? '')) throw new Error('unresolved commit');
  return sha;
}

const show = (root, sha, path, timeoutMs) => git(root, ['show', `${sha}:${path}`], { allowFail: true, timeoutMs });

/** Strict `git diff --raw -z`: `:oldmode newmode oldoid newoid status\0path\0[,oldpath\0]`. */
function parseEvidence(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes[bytes.length - 1] !== 0) throw new Error('evidence');
  const parts = bytes.toString('latin1').split('\0');
  parts.pop();
  const records = [];
  for (let i = 0; i < parts.length; i += 1) {
    const header = parts[i].match(/^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDTCR])([0-9]{0,3})$/);
    if (!header || !OID.test(header[3]) || !OID.test(header[4])) throw new Error('evidence');
    const [, oldMode, newMode, oldOid, newOid, status] = header;
    const pair = status === 'R' || status === 'C';
    const path = Buffer.from(parts[i + 1] ?? '', 'latin1').toString('utf8');
    const oldPath = pair ? Buffer.from(parts[i + 2] ?? '', 'latin1').toString('utf8') : undefined;
    if (!path || (pair && !oldPath)) throw new Error('evidence');
    records.push({ oldMode, newMode, oldOid, newOid, status, path, oldPath });
    i += pair ? 2 : 1;
  }
  return records;
}

async function readBlobs(root, records, timeoutMs) {
  const oids = new Set();
  for (const record of records) {
    for (const [mode, oid] of [[record.oldMode, record.oldOid], [record.newMode, record.newOid]]) {
      if (mode !== GITLINK && mode !== ZERO_MODE && !ZERO.test(oid)) oids.add(oid);
    }
  }
  const blobs = new Map();
  for (const oid of oids) blobs.set(oid, await git(root, ['cat-file', 'blob', oid], { timeoutMs }));
  return blobs;
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
function decode(buf) {
  try { return UTF8.decode(buf); } catch { return undefined; }
}
const isBinary = (buf) => buf.includes(0) || decode(buf) === undefined;

/** Multiset line difference: lines that only moved are neither added nor removed. */
function addedLines(baseText, headText) {
  const counts = new Map();
  for (const line of baseText.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added = [];
  headText.split('\n').forEach((line, index) => {
    const count = counts.get(line) ?? 0;
    if (count > 0) counts.set(line, count - 1);
    else added.push({ line: index + 1, text: line });
  });
  return added;
}

/** Verdict-contract literals read statically from the base `lib/verdict.mjs` text. */
function verdictTokens(source) {
  const tokens = new Set();
  for (const match of String(source ?? '').matchAll(/normalized\s*===\s*'([^'\\\n]{1,32})'/g)) tokens.add(match[1].trim());
  return [...tokens].filter(Boolean);
}

function commitParts(text) {
  const cut = text.indexOf('\n\n');
  const header = cut < 0 ? text : text.slice(0, cut);
  const message = cut < 0 ? '' : text.slice(cut + 2);
  const identities = header.split('\n')
    .filter((line) => line.startsWith('author ') || line.startsWith('committer '))
    .map((line) => line.slice(line.indexOf(' ') + 1));
  return { identities, message };
}

const lineOf = (location, value, offset) => location.line
  || (typeof value === 'string' ? value.slice(0, offset).split('\n').length : 0);

export async function runGate0(options = {}) {
  const {
    root, baseRef, headRef = 'HEAD', issue, metadata = {}, denylistPath, expectedSha256,
    sandbox, runtime = process.version, timeoutMs = TIMEOUT_MS,
  } = options ?? {};
  const errors = [];
  let blocked = false;
  const fail = (rule, path, isBlock, line = 0) => {
    errors.push({ rule, path, line });
    if (isBlock) blocked = true;
  };
  try {
    if (typeof root !== 'string' || root === '' || typeof baseRef !== 'string' || baseRef === ''
      || !Array.isArray(issue?.allowedPaths) || issue.allowedPaths.length === 0) {
      return { verdict: 'block', passed: false, errors: [{ rule: 'input', path: '<gate>', line: 0 }] };
    }
    const base = await resolve(root, baseRef, timeoutMs);
    const head = await resolve(root, headRef, timeoutMs);
    const evidence = await git(root, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--find-copies',
      '--no-ext-diff', '--no-textconv', base, head, '--'], { timeoutMs });
    const records = parseEvidence(evidence);
    const blobs = await readBlobs(root, records, timeoutMs);

    const [packageBase, packageHead, lockBase, verdictSource, templateNames, headTree] = await Promise.all([
      show(root, base, 'package.json', timeoutMs),
      show(root, head, 'package.json', timeoutMs),
      show(root, base, 'package-lock.json', timeoutMs),
      show(root, base, 'lib/verdict.mjs', timeoutMs),
      gitText(root, ['ls-tree', '-r', '--name-only', base, '--', TEMPLATES], { allowFail: true, timeoutMs }),
      gitText(root, ['ls-tree', '-r', '--name-only', head], { timeoutMs }),
    ]);
    const templates = [];
    for (const path of (templateNames ?? '').split('\n').filter((name) => name.endsWith('.md'))) {
      const content = await show(root, base, path, timeoutMs);
      if (content) templates.push({ path, content: content.toString('utf8') });
    }
    const discovered = (headTree ?? '').split('\n').filter((path) => TEST_PATH.test(path));

    const allow = Object.fromEntries(ALLOW_KEYS.map((key) => [key, issue.allowChanges?.[key] === true]));
    const baseline = {
      ...(issue.baseline ?? {}),
      templates,
      frozenTokens: [...(issue.baseline?.frozenTokens ?? []), ...verdictTokens(verdictSource?.toString('utf8'))],
    };
    const policy = validateDiffPolicy({ base, head, evidence, blobs, allowedPaths: issue.allowedPaths, allow, baseline });

    // Hygiene surfaces: changed paths, added head lines, commit identity/message, caller metadata
    // (additive) and the content of binary/symlink head blobs.
    const entries = [];
    const where = [];
    const push = (path, line, value, extra = {}) => {
      entries.push({ source: String(entries.length), value });
      where.push({ path, line, ...extra });
    };
    for (const record of records) {
      for (const path of [record.path, record.oldPath].filter(Boolean)) {
        push('<redacted>', 0, path, { realPath: path, pathEntry: true });
      }
    }
    for (const record of records) {
      if (record.status === 'D' || record.newMode === GITLINK || ZERO.test(record.newOid)) continue;
      const headBuf = blobs.get(record.newOid);
      if (!headBuf) continue;
      if (record.newMode === SYMLINK || isBinary(headBuf)) { push('<binary>', 0, headBuf); continue; }
      const baseBuf = record.oldMode === ZERO_MODE || ZERO.test(record.oldOid) ? Buffer.alloc(0) : blobs.get(record.oldOid);
      const baseText = baseBuf ? decode(baseBuf) ?? '' : '';
      for (const line of addedLines(baseText, decode(headBuf) ?? '')) push(record.path, line.line, line.text, { realPath: record.path });
    }
    const commits = ((await gitText(root, ['rev-list', '--reverse', `${base}..${head}`], { timeoutMs })) ?? '')
      .split('\n').filter(Boolean);
    for (const sha of commits) {
      const parts = commitParts((await git(root, ['cat-file', 'commit', sha], { timeoutMs })).toString('utf8'));
      push('<commit>', 0, parts.message);
      for (const identity of parts.identities) push('<commit>', 0, identity);
    }
    for (const value of [metadata.prTitle, metadata.prBody, metadata.branch,
      ...(Array.isArray(metadata.commitMessages) ? metadata.commitMessages : []),
      ...(Array.isArray(metadata.authors) ? metadata.authors : [])]) {
      if (typeof value === 'string' && value !== '') push('<metadata>', 0, value);
    }

    const flagged = new Set();
    try {
      const findings = await scanHygiene({ entries, denylistPath, repoRoot: root, expectedSha256 });
      const found = findings.map((finding) => ({ finding, location: where[Number(finding.source.replace('entry-', ''))] }));
      for (const { location } of found) if (location.pathEntry) flagged.add(location.realPath);
      for (const { finding, location } of found) {
        const redacted = location.pathEntry || flagged.has(location.realPath);
        const value = entries[Number(finding.source.replace('entry-', ''))].value;
        fail(`hygiene:${finding.kind}`, redacted ? '<redacted>' : location.path, false, lineOf(location, value, finding.offset));
      }
    } catch {
      fail('hygiene:config', '<denylist>', true);
    }
    for (const error of policy.errors) {
      fail(error.rule, flagged.has(error.path) ? '<redacted>' : error.path, BLOCK_POLICY.has(error.rule));
    }

    if (errors.length === 0) {
      const execution = await runGateExecution({
        base, head,
        packageBase: packageBase?.toString('utf8'),
        packageHead: packageHead?.toString('utf8'),
        lockfile: { text: lockBase?.toString('utf8') ?? '', hash: createHash('sha256').update(lockBase ?? '').digest('hex') },
        runtime, sandbox, discovered, timeoutMs,
      });
      for (const error of execution.errors) fail(error.rule, error.path, BLOCK_EXEC.has(error.rule), error.line ?? 0);
    }

    const verdict = blocked ? 'block' : errors.length > 0 ? 'reject' : 'pass';
    return { verdict, passed: verdict === 'pass', errors };
  } catch {
    return { verdict: 'block', passed: false, errors: [...errors, { rule: 'internal', path: '<gate>', line: 0 }] };
  }
}
