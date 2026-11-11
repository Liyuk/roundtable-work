// Gate 0: deterministic acceptance checks for a delivery (issue #28).
//
// Deterministic, zero dependencies, no network, no model. Gate 0 can only
// REJECT or BLOCK a delivery; it can never approve one. A `pass` result means
// "no deterministic objection": it is necessary but NOT sufficient for approval,
// and no model may override a reject or block.
//
// Repository target: English-only (Discussion #9). The correct translation
// direction is Chinese -> English; a diff that flips it (fully or partially)
// fails. Machine contracts are frozen (status words, field names, placeholders,
// the reviewer first line, verdict aliases, continuation words).
//
// Rules implemented here:
//   1 Tests        G0-TESTS, G0-TEST-COUNT, G0-TEST-SKIP
//   2 Path scope   G0-SCOPE-PATH, G0-SCOPE-PROTECTED, G0-SCOPE-SPECIAL
//   3 Frozen tokens G0-TOKEN, G0-VERDICT-LINE
//   4 Direction    G0-LANG-CJK, G0-LANG-BALANCE
//   5/6 Hygiene    HYG-* (see ./hygiene.mjs; output carries no matched text)
//   7 Fail-closed  any internal error / timeout / missing input => block
//
// Result: { verdict: 'pass' | 'reject' | 'block', findings, blocks }
//   findings: [{ ruleId, path, line, length, hash }]  (no matched text)
//   blocks:   [{ ruleId }]                            (rule IDs only, no messages)
//
// Inputs (all base-side unless noted; the diff under review can never widen them):
//   root, baseRef        git mode: the diff is computed against merge-base(baseRef, HEAD)
//   diff                 pre-parsed diff (see `normalizeDiff`); replaces git mode
//   issue                { allowedPaths, allowChanges?, allowSkip? }
//   metadata             { commitMessages, authors, prTitle, prBody, branch }
//   denylist | hostRun   fixture denylist, or load from $RT_HOME (outside the repo)
//   runner               injected async test runner (see `defaultRunner`)
//   baseline             { cjkPathAllowlist, testFakes, frozenTokens, templates }
//                        in git mode read from `runtime/gate0-baseline.json` at the base
//   timeoutMs, runnerTimeoutMs, networkIsolated, depsDir, env
//
// No-network enforcement: pure Node cannot sandbox the network. What this module
// does: the test runner gets a scrubbed environment (no proxy, no registry, no
// credentials, npm forced offline), only `node` steps are executed (no shell),
// and a host run (`hostRun: true`) that does not assert `networkIsolated: true`
// (the host runs Gate 0 inside a network-less namespace) is a BLOCK.
//
// Known limitations (documented on purpose):
//   - Frozen English tokens such as `done` or `review` are ordinary words; the
//     check is a per-file word-boundary count that must not decrease, so
//     rewording prose that contains them can be a false reject.
//   - Frozen Chinese tokens are counted only when not adjacent to another Han
//     character, so ordinary Chinese prose that merely contains them is ignored.
//   - Test-case counting is a static textual count of test( / it( calls.

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadDenylist, scanHygiene, hashText, formatFindings, HygieneError } from './hygiene.mjs';
import { parseVerdict } from '../../lib/verdict.mjs';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BASELINE_PATH = 'runtime/gate0-baseline.json';
export const TEMPLATES_DIR = '.agents/skills/roundtable-work/templates/';
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_RUNNER_TIMEOUT_MS = 300000;
const MAX_BUFFER = 256 * 1024 * 1024;

// CJK characters are written as escapes so this file stays ASCII-only.
const ZH = Object.freeze({
  PASS: '\u901a\u8fc7',
  REJECT: '\u6253\u56de',
  BLOCK: '\u963b\u585e',
  COMPLETE: '\u5b8c\u6210',
  PARTIAL: '\u90e8\u5206\u5b8c\u6210',
  FAILED: '\u5931\u8d25',
  UNKNOWN: '\u672a\u77e5',
  REVIEW_LABEL: '\u5ba1\u67e5\u7ed3\u8bba',
});
const FULLWIDTH_COLON = '\uff1a';

// Unicode script properties cover halfwidth kana, jamo, compatibility ideographs and
// the astral Han extensions. The source stays ASCII.
const HAN = '\\p{Script=Han}';
const CJK_ALT = `${HAN}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}`;
const CJK_RE = new RegExp(`(?:${CJK_ALT})`, 'gu');
const HAS_CJK_RE = new RegExp(`(?:${CJK_ALT})`, 'u');

// Status words, continuation words and delivery statuses that are not verdict forms.
// The verdict forms themselves (Chinese, English, alias) are derived from lib/verdict.mjs.
const TICKET_STATUS_WORDS = [
  'queued', 'assigned', 'working', 'review', 'ready', 'done',
  'waiting_external', 'waiting_person', 'blocked', 'failed', 'cancelled', 'unknown',
];
const DELIVERY_STATUS_WORDS = [ZH.COMPLETE, ZH.PARTIAL, ZH.FAILED, ZH.BLOCK, ZH.UNKNOWN];
const CONTINUATION_WORDS = ['continue', 'wait', 'ask', 'done', 'stop'];
// Candidate forms probed against parseVerdict; only accepted forms enter the registry.
const VERDICT_PROBES = [
  ZH.PASS, ZH.REJECT, ZH.BLOCK, 'passed', 'rejected', 'blocked', 'returned',
];

// Protected categories: out of scope unless the issue explicitly allows them.
const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const CI_PATTERNS = ['.github/**', '.gitlab-ci.yml', '.circleci/**', '.nvmrc', '.node-version'];
const PROTECTED = [
  { flag: 'gate0', test: (p) => p.startsWith('runtime/') || p.startsWith('test/runtime/') },
  { flag: 'verdict', test: (p) => p === 'lib/verdict.mjs' },
  { flag: 'allowlists', test: (p) => p === BASELINE_PATH },
  { flag: 'packageJson', test: (p) => baseName(p) === 'package.json' },
  { flag: 'lockfiles', test: (p) => LOCKFILE_NAMES.includes(baseName(p)) },
  { flag: 'ci', test: (p) => CI_PATTERNS.some((g) => globToRegExp(g).test(p)) },
];

// ---------------------------------------------------------------------------
// Errors (messages are rule IDs only, never exception text)
// ---------------------------------------------------------------------------

class GateSignal extends Error {
  constructor(ruleId) {
    super(ruleId);
    this.name = 'GateSignal';
    this.ruleId = ruleId;
  }
}

function blockCodeOf(err) {
  if (err instanceof GateSignal) return err.ruleId;
  if (err instanceof HygieneError) {
    if (err.code === 'TIMEOUT') return 'G0-TIMEOUT';
    return /^DENYLIST_/.test(String(err.code)) ? 'G0-DENYLIST' : 'G0-INPUT';
  }
  return 'G0-INTERNAL';
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function baseName(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function countCjk(text) {
  const m = String(text).match(CJK_RE);
  return m ? m.length : 0;
}

export function hasCjk(text) {
  return HAS_CJK_RE.test(String(text));
}

function normPath(p) {
  return String(p).replace(/^\.\//, '');
}

/** Glob to RegExp: `**` any depth, `*` within a segment, `?` one char, trailing `/` = prefix. */
export function globToRegExp(glob) {
  let g = normPath(glob);
  if (g.endsWith('/')) g += '**';
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeRe(c);
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAny(path, globs) {
  const p = normPath(path);
  return globs.some((g) => globToRegExp(g).test(p));
}

function validGlobList(list) {
  return Array.isArray(list) && list.every((g) => typeof g === 'string' && g.length > 0
    && !g.split('/').includes('..') && !g.startsWith('/'));
}

// ---------------------------------------------------------------------------
// Frozen-token registry (rule 3)
// ---------------------------------------------------------------------------

/**
 * Derive the verdict forms from lib/verdict.mjs by probing parseVerdict.
 * Candidates = the probe pool plus quoted literals found in the base-side
 * verdict source (when given). Returns { tokens, chinese: {passed, rejected, blocked} }.
 * This is the only place the verdict part of the registry is derived.
 */
export function deriveVerdictTokens(verdictSource) {
  const candidates = new Set(VERDICT_PROBES);
  if (typeof verdictSource === 'string') {
    for (const m of verdictSource.matchAll(/'([^'\\\n]{1,32})'|"([^"\\\n]{1,32})"/g)) {
      const lit = (m[1] ?? m[2]).trim();
      if (lit && !/\s/.test(lit)) candidates.add(lit);
    }
  }
  const tokens = [];
  const chinese = {};
  for (const cand of candidates) {
    let normalized;
    try { normalized = parseVerdict(cand); } catch { continue; }
    tokens.push(cand);
    if (hasCjk(cand) && chinese[normalized] === undefined) chinese[normalized] = cand;
  }
  for (const required of VERDICT_PROBES) {
    if (!tokens.includes(required)) throw new GateSignal('G0-REGISTRY');
  }
  if (!chinese.passed || !chinese.rejected || !chinese.blocked) throw new GateSignal('G0-REGISTRY');
  return { tokens, chinese };
}

/** Field labels and placeholders from base templates (`- label:` bullets and `<...>`). */
export function deriveTemplateTokens(templates) {
  const tokens = new Set();
  for (const t of Array.isArray(templates) ? templates : []) {
    if (!t || typeof t.content !== 'string') continue;
    const lines = t.content.split(/\r?\n/);
    const requiredHeading = (l) => /^#{1,6}\s.*(?:Required|\u5fc5\u586b)/i.test(l);
    const hasRequired = lines.some(requiredHeading);
    let inRequired = !hasRequired;
    for (const line of lines) {
      if (/^#{1,6}\s/.test(line)) inRequired = !hasRequired || requiredHeading(line);
      const label = /^\s*[-*]\s+(.+?):(?:\s|$)/.exec(line);
      if (label && inRequired) {
        let name = label[1].split(' (')[0].split(', ')[0].trim();
        name = name.replace(/^`|`$/g, '');
        if (name.length >= 2 && name.length <= 80) tokens.add(name);
      }
      for (const ph of line.matchAll(/<[^<>\n]{1,40}>/g)) tokens.add(ph[0]);
    }
  }
  return [...tokens];
}

/**
 * Build the frozen-token registry.
 * Returns { tokens: string[], verdictLine: RegExp (global) }.
 */
export function buildRegistry({ verdictSource, templates, extras } = {}) {
  const verdict = deriveVerdictTokens(verdictSource);
  const set = new Set([
    ...TICKET_STATUS_WORDS, ...DELIVERY_STATUS_WORDS, ...CONTINUATION_WORDS,
    ZH.REVIEW_LABEL, ...verdict.tokens,
    ...deriveTemplateTokens(templates),
    ...(Array.isArray(extras) ? extras.filter((x) => typeof x === 'string' && x.length > 0) : []),
  ]);
  const tokens = [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const { passed, rejected, blocked } = verdict.chinese;
  // An English parenthetical after a frozen token is allowed.
  const tok = (t) => `${escapeRe(t)}(?:\\s*\\([^()\\n]*\\))?`;
  const verdictLine = new RegExp(
    `${ZH.REVIEW_LABEL}[:${FULLWIDTH_COLON}]\\s*${tok(passed)}\\s*\\|\\s*${tok(rejected)}\\s*\\|\\s*${escapeRe(blocked)}`,
    'g',
  );
  return { tokens, verdictLine };
}

const tokenReCache = new Map();
function tokenRegExp(token) {
  let re = tokenReCache.get(token);
  if (!re) {
    const body = escapeRe(token);
    if (hasCjk(token)) re = new RegExp(`(?<!${HAN})${body}(?!${HAN})`, 'gu');
    else if (/^\w+$/.test(token)) re = new RegExp(`(?<!\\w)${body}(?!\\w)`, 'g');
    else re = new RegExp(body, 'g');
    tokenReCache.set(token, re);
  }
  return re;
}

/** Occurrences of a token: word-boundary for words, non-Han-adjacent for Chinese tokens. */
export function countToken(text, token) {
  const m = String(text).match(tokenRegExp(token));
  return m ? m.length : 0;
}

function countRegex(text, re) {
  const m = String(text).match(re);
  return m ? m.length : 0;
}

/** Remove registry tokens that contain CJK from a line (for the direction check). */
export function stripFrozenCjk(line, tokens) {
  let out = String(line);
  for (const t of tokens) {
    if (hasCjk(t)) out = out.replace(tokenRegExp(t), ' ');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diff model
// ---------------------------------------------------------------------------

/**
 * Validate and normalize a pre-parsed diff:
 *   { files: [{ status: 'A'|'M'|'D'|'R'|'C'|'T', path, oldPath?, oldMode?, newMode?,
 *               binary?, added: [{line,text}], removed: [{line,text}],
 *               baseContent?, headContent? }],
 *     base?: { packageJson, templates, verdictSource, baseline } }
 */
export function normalizeDiff(diff) {
  if (!diff || typeof diff !== 'object' || !Array.isArray(diff.files)) throw new GateSignal('G0-INPUT');
  const files = diff.files.map((f) => {
    if (!f || typeof f.path !== 'string' || !/^[AMDRCT]$/.test(String(f.status))) throw new GateSignal('G0-INPUT');
    if ((f.status === 'R' || f.status === 'C') && typeof f.oldPath !== 'string') throw new GateSignal('G0-INPUT');
    const lines = (arr) => (Array.isArray(arr) ? arr : []).map((l) => {
      if (!l || typeof l.text !== 'string') throw new GateSignal('G0-INPUT');
      return { line: Number.isInteger(l.line) ? l.line : 0, text: l.text };
    });
    return {
      status: f.status,
      path: normPath(f.path),
      oldPath: f.oldPath === undefined ? undefined : normPath(f.oldPath),
      oldMode: f.oldMode === undefined ? '' : String(f.oldMode),
      newMode: f.newMode === undefined ? '' : String(f.newMode),
      binary: f.binary === true,
      added: lines(f.added),
      removed: lines(f.removed),
      baseContent: typeof f.baseContent === 'string' ? f.baseContent : '',
      headContent: typeof f.headContent === 'string' ? f.headContent : '',
    };
  });
  return { files, base: diff.base && typeof diff.base === 'object' ? diff.base : {} };
}

/** Path of a file on the base side (rename source or the path itself). */
function basePathOf(f) {
  return f.status === 'R' || f.status === 'C' ? f.oldPath : f.path;
}

// ---------------------------------------------------------------------------
// Git collection (execFile, no shell)
// ---------------------------------------------------------------------------

async function git(root, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileP('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: root, maxBuffer: MAX_BUFFER, encoding: 'utf8',
      env: { PATH: process.env.PATH || '', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
  } catch {
    if (allowFail) return undefined;
    throw new GateSignal('G0-GIT');
  }
}

function parseHunks(patch) {
  const added = [];
  const removed = [];
  let inHunk = false;
  let newLn = 0;
  let oldLn = 0;
  for (const raw of patch.split('\n')) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) { inHunk = true; oldLn = Number(h[1]); newLn = Number(h[2]); continue; }
    if (!inHunk) continue;
    if (raw.startsWith('+')) added.push({ line: newLn++, text: raw.slice(1).replace(/\r$/, '') });
    else if (raw.startsWith('-')) removed.push({ line: oldLn++, text: raw.slice(1).replace(/\r$/, '') });
  }
  return { added, removed };
}

/** Compute the diff model from git: merge-base(baseRef, HEAD) .. HEAD. */
export async function collectGitDiff({ root, baseRef }) {
  if (typeof root !== 'string' || !root || typeof baseRef !== 'string' || !baseRef || baseRef.startsWith('-')) {
    throw new GateSignal('G0-INPUT');
  }
  const mergeBase = (await git(root, ['merge-base', baseRef, 'HEAD'])).trim();
  if (!/^[0-9a-f]{40,64}$/.test(mergeBase)) throw new GateSignal('G0-GIT');

  const rawOut = await git(root, ['diff', '--find-renames', '--raw', '-z', '--no-color', '--no-ext-diff', mergeBase, 'HEAD']);
  const numOut = await git(root, ['diff', '--find-renames', '--numstat', '-z', '--no-color', '--no-ext-diff', mergeBase, 'HEAD']);

  const entries = [];
  const rt = rawOut.split('\0');
  for (let i = 0; i < rt.length; i++) {
    const meta = /^:(\d+) (\d+) \S+ \S+ ([A-Z])\d*$/.exec(rt[i]);
    if (!meta) continue;
    const status = meta[3];
    if (status === 'R' || status === 'C') { entries.push({ status, oldMode: meta[1], newMode: meta[2], oldPath: rt[i + 1], path: rt[i + 2] }); i += 2; }
    else { entries.push({ status, oldMode: meta[1], newMode: meta[2], path: rt[i + 1] }); i += 1; }
  }
  const binary = new Set();
  const nt = numOut.split('\0');
  for (let i = 0; i < nt.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(nt[i]);
    if (!m) continue;
    let path = m[3];
    if (path === '') { path = nt[i + 2]; i += 2; }
    if (m[1] === '-' && m[2] === '-') binary.add(path);
  }

  const files = [];
  for (const e of entries) {
    const isBinary = binary.has(e.path);
    const special = e.oldMode === '120000' || e.newMode === '120000' || e.oldMode === '160000' || e.newMode === '160000';
    const specs = e.oldPath ? [e.oldPath, e.path] : [e.path];
    let added = [];
    let removed = [];
    let baseContent = '';
    let headContent = '';
    if (!isBinary && !special) {
      const patch = await git(root, ['diff', '--find-renames', '-U0', '--no-color', '--no-ext-diff', mergeBase, 'HEAD', '--', ...specs]);
      ({ added, removed } = parseHunks(patch));
      const bp = e.status === 'R' || e.status === 'C' ? e.oldPath : e.path;
      if (e.status !== 'A') baseContent = (await git(root, ['show', `${mergeBase}:${bp}`], { allowFail: true })) ?? '';
      if (e.status !== 'D') headContent = (await git(root, ['show', `HEAD:${e.path}`], { allowFail: true })) ?? '';
    }
    files.push({ ...e, binary: isBinary, added, removed, baseContent, headContent });
  }

  const showBase = (p) => git(root, ['show', `${mergeBase}:${p}`], { allowFail: true });
  const names = (await git(root, ['ls-tree', '--name-only', mergeBase, TEMPLATES_DIR], { allowFail: true })) ?? '';
  const templates = [];
  for (const name of names.split('\n').filter((n) => n.endsWith('.md'))) {
    const content = await showBase(name);
    if (typeof content === 'string') templates.push({ path: name, content });
  }
  const baselineText = await showBase(BASELINE_PATH);
  let baseline;
  if (baselineText !== undefined) {
    try { baseline = JSON.parse(baselineText); } catch { throw new GateSignal('G0-INPUT'); }
  }

  const log = (await git(root, ['log', '--format=%an <%ae>%x1f%cn <%ce>%x1f%B%x1e', `${mergeBase}..HEAD`])) ?? '';
  const commitMessages = [];
  const authors = [];
  for (const rec of log.split('\x1e')) {
    if (!rec.trim()) continue;
    const [a, c, body] = rec.replace(/^\n/, '').split('\x1f');
    authors.push(a, c);
    commitMessages.push(body ?? '');
  }

  return {
    files,
    base: {
      packageJson: await showBase('package.json'),
      verdictSource: await showBase('lib/verdict.mjs'),
      templates,
      baseline,
    },
    gitMeta: { commitMessages, authors },
  };
}

// ---------------------------------------------------------------------------
// Rule 1: tests
// ---------------------------------------------------------------------------

const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__)\/.*\.[cm]?[jt]s$|\.(?:test|spec)\.[cm]?[jt]s$/;

export function isTestFile(path) {
  return TEST_FILE_RE.test(path) && !/(?:^|\/)fixtures\//.test(path);
}

// Built from pieces so this file does not trip its own skip scan.
// Covers the dotted forms and the option forms (`{ skip: true }`, `{ only: true }`, `{ skip }`).
const SKIP_RE = new RegExp(
  [
    `\\.${'sk'}ip\\b`, `\\.${'on'}ly\\b`, `\\b${'to'}do\\b`, `\\b${'x'}it\\b`,
    `\\b${'sk'}ip\\s*:`, `\\b${'on'}ly\\s*:`, `\\{\\s*${'sk'}ip\\b`, `\\{\\s*${'on'}ly\\b`,
  ].join('|'),
  'i',
);
const CASE_RE = /(?:^|[^\w.$])(?:test|it)(?:\.(?:only|skip|todo))?\s*\(/gm;

export function countTestCases(content) {
  return countRegex(content, CASE_RE);
}

/** Delta of test files / cases between base and head over the changed files. */
export function testStats(files) {
  let baseFiles = 0;
  let headFiles = 0;
  let baseCases = 0;
  let headCases = 0;
  for (const f of files) {
    if (f.binary) continue;
    if (f.status !== 'A' && isTestFile(basePathOf(f))) { baseFiles++; baseCases += countTestCases(f.baseContent); }
    if (f.status !== 'D' && isTestFile(f.path)) { headFiles++; headCases += countTestCases(f.headContent); }
  }
  return { baseFiles, headFiles, baseCases, headCases };
}

/** Resolve the base test script into node steps (no shell): used by the default runner. */
export function resolveTestSteps(scripts, command = scripts && scripts.test, depth = 0) {
  if (typeof command !== 'string' || depth > 4) throw new GateSignal('G0-TEST-COMMAND');
  const steps = [];
  for (const part of command.split('&&').map((s) => s.trim())) {
    if (!part || /[;|<>`$()&\\"']/.test(part)) throw new GateSignal('G0-TEST-COMMAND');
    const argv = part.split(/\s+/);
    if (argv[0] === 'node') {
      steps.push(argv);
    } else if (argv[0] === 'npm' && argv.length === 2 && argv[1] === 'test') {
      steps.push(...resolveTestSteps(scripts, scripts.test, depth + 1));
    } else if (argv[0] === 'npm' && argv.length === 3 && (argv[1] === 'run' || argv[1] === 'run-script')) {
      steps.push(...resolveTestSteps(scripts, scripts[argv[2]], depth + 1));
    } else {
      throw new GateSignal('G0-TEST-COMMAND');
    }
  }
  return steps;
}

const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'TZ'];

/**
 * Environment handed to the test runner: an allowlist copy plus forced-offline
 * settings. No proxy, no registry, no credentials, no RT_HOME.
 */
export function buildRunnerEnv(env = process.env, home = '') {
  const out = {};
  for (const k of ENV_KEEP) if (typeof env[k] === 'string') out[k] = env[k];
  out.CI = '1';
  out.NO_COLOR = '1';
  if (home) Object.assign(out, { HOME: home, TMPDIR: home });
  out.npm_config_offline = 'true';
  out.npm_config_audit = 'false';
  out.npm_config_fund = 'false';
  out.npm_config_update_notifier = 'false';
  return out;
}

function nodeSatisfies(range, version = process.versions.node) {
  if (typeof range !== 'string' || !range.trim()) throw new GateSignal('G0-NODE');
  const cur = version.split('.').map(Number);
  const cmp = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; } return 0; };
  for (const c of range.trim().split(/\s+/)) {
    const m = /^(>=|<=|>|<|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(c);
    if (!m) throw new GateSignal('G0-NODE');
    const target = [Number(m[2]), Number(m[3] || 0), Number(m[4] || 0)];
    const r = cmp(cur, target);
    const op = m[1] || '=';
    const ok = (op === '>=' && r >= 0) || (op === '<=' && r <= 0) || (op === '>' && r > 0)
      || (op === '<' && r < 0) || (op === '=' && (m[3] === undefined ? cur[0] === target[0] : r === 0));
    if (!ok) return false;
  }
  return true;
}
export { nodeSatisfies };

/**
 * Default test runner for a real run. Spec: { root, baseRef, mergeBase?, command, scripts,
 * engines, env, timeoutMs, signal, depsDir, baseFiles }. It checks out HEAD into a
 * temp dir, restores the BASE package.json (the only entry the caller passes in
 * `baseFiles`; lockfiles and CI config are NOT restored, because dependencies come
 * from the host-supplied `depsDir` and CI config is never executed here), pins
 * Node per the base `engines`, and runs the base test command as node steps (no shell).
 * Dependencies must be provided by the host as `depsDir` (base-lockfile install);
 * a base package that declares dependencies without `depsDir` is a block.
 * Output is never returned (it could carry identifiers): only the exit status.
 */
export async function defaultRunner(spec) {
  if (!spec || typeof spec.root !== 'string') throw new GateSignal('G0-INPUT');
  const pkg = spec.basePackage || {};
  if (!nodeSatisfies(spec.engines && spec.engines.node)) throw new GateSignal('G0-NODE');
  const hasDeps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length > 0;
  if (hasDeps && !spec.depsDir) throw new GateSignal('G0-DEPS');
  const steps = resolveTestSteps(spec.scripts, spec.command);
  const tmp = await mkdtemp(join(tmpdir(), 'gate0-'));
  try {
    const work = join(tmp, 'work');
    await mkdir(work);
    await execFileP('git', ['archive', '--format=tar', '-o', join(tmp, 'head.tar'), 'HEAD'], { cwd: spec.root });
    await execFileP('tar', ['-xf', join(tmp, 'head.tar'), '-C', work]);
    for (const [rel, content] of Object.entries(spec.baseFiles || {})) {
      await mkdir(dirname(join(work, rel)), { recursive: true });
      await writeFile(join(work, rel), content);
    }
    if (spec.depsDir) await symlink(spec.depsDir, join(work, 'node_modules'), 'dir');
    const env = buildRunnerEnv(spec.env || process.env, tmp);
    for (const argv of steps) {
      try {
        await execFileP(process.execPath, argv.slice(1), {
          cwd: work, env, timeout: spec.timeoutMs, signal: spec.signal, maxBuffer: MAX_BUFFER,
        });
      } catch (err) {
        if (err && (err.killed || err.name === 'AbortError')) return { exitCode: null, timedOut: true };
        return { exitCode: typeof err.code === 'number' ? err.code : 1 };
      }
    }
    return { exitCode: 0 };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function withTimeout(promiseFactory, ms, controller) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ exitCode: null, timedOut: true }); }, ms);
    if (timer.unref) timer.unref();
  });
  try { return await Promise.race([promiseFactory(), timeout]); } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function mk(ruleId, path, line = 0, subject = '') {
  const s = String(subject);
  return { ruleId, path, line, length: s.length, hash: hashText(`${ruleId}|${path}|${line}|${s}`) };
}

// ---------------------------------------------------------------------------
// Rule 2: path scope
// ---------------------------------------------------------------------------

export function checkScope(files, issue) {
  const findings = [];
  const allow = issue.allowChanges || {};
  const check = (path, kind) => {
    if (!matchesAny(path, issue.allowedPaths)) findings.push(mk('G0-SCOPE-PATH', path, 0, kind));
    for (const p of PROTECTED) {
      if (p.test(path) && allow[p.flag] !== true) findings.push(mk('G0-SCOPE-PROTECTED', path, 0, p.flag));
    }
  };
  for (const f of files) {
    check(f.path, 'new');
    if ((f.status === 'R' || f.status === 'C') && f.oldPath !== f.path) check(f.oldPath, 'old');
    const modes = [f.oldMode, f.newMode];
    if (modes.includes('120000') && allow.symlinks !== true) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'symlink'));
    if (modes.includes('160000') && allow.submodules !== true) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'submodule'));
    if (f.binary && allow.binaries !== true) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'binary'));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 3: frozen tokens
// ---------------------------------------------------------------------------

export function checkFrozenTokens(files, registry) {
  const findings = [];
  for (const f of files) {
    if (f.binary || f.oldMode === '120000' || f.newMode === '120000' || f.oldMode === '160000' || f.newMode === '160000') continue;
    for (const token of registry.tokens) {
      const before = countToken(f.baseContent, token);
      if (before === 0) continue;
      const after = countToken(f.headContent, token);
      if (after < before) findings.push(mk('G0-TOKEN', f.path, 0, token));
    }
    const lineBefore = countRegex(f.baseContent, registry.verdictLine);
    if (lineBefore > 0 && countRegex(f.headContent, registry.verdictLine) < lineBefore) {
      findings.push(mk('G0-VERDICT-LINE', f.path, 0, 'first-line'));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 4: language direction
// ---------------------------------------------------------------------------

export function checkDirection(files, registry, cjkPathAllowlist = []) {
  const findings = [];
  for (const f of files) {
    if (f.binary) continue;
    if (matchesAny(f.path, cjkPathAllowlist)) continue;
    for (const l of f.added) {
      const residue = stripFrozenCjk(l.text, registry.tokens);
      const n = countCjk(residue);
      if (n > 0) findings.push(mk('G0-LANG-CJK', f.path, l.line, residue.match(CJK_RE).join('')));
    }
    const added = f.added.reduce((s, l) => s + countCjk(l.text), 0);
    const removed = f.removed.reduce((s, l) => s + countCjk(l.text), 0);
    if (added > removed) findings.push(mk('G0-LANG-BALANCE', f.path, 0, `${added}>${removed}`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 1 (static part): test counts and skip markers
// ---------------------------------------------------------------------------

export function checkTestIntegrity(files, issue) {
  const findings = [];
  const allow = issue.allowChanges || {};
  const stats = testStats(files);
  if (allow.tests !== true && (stats.headFiles < stats.baseFiles || stats.headCases < stats.baseCases)) {
    findings.push(mk('G0-TEST-COUNT', '<tests>', 0, JSON.stringify(stats)));
  }
  if (issue.allowSkip !== true) {
    for (const f of files) {
      if (f.binary || f.status === 'D' || !isTestFile(f.path)) continue;
      for (const l of f.added) {
        if (SKIP_RE.test(l.text)) findings.push(mk('G0-TEST-SKIP', f.path, l.line, l.text));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rules 5-6: hygiene
// ---------------------------------------------------------------------------

function collectHygiene(files, metadata, denylist, baseline, deadline) {
  const addedLines = [];
  const paths = [];
  for (const f of files) {
    if (f.status === 'A' || f.status === 'R' || f.status === 'C') paths.push(f.path);
    if (f.binary) continue;
    for (const l of f.added) addedLines.push({ path: f.path, line: l.line, text: l.text });
  }
  return scanHygiene({ addedLines, paths, metadata, denylist, deadline, allowlist: { testFakes: baseline.testFakes || [] } });
}

const EMPTY_DENYLIST = { hostnames: { distinctive: [], common: [] }, usernames: { distinctive: [], common: [] } };

/** Replace paths that themselves look sensitive with `<path:HASH8>`. */
function redactPaths(findings, denylist) {
  const cache = new Map();
  const show = (p) => {
    if (!cache.has(p)) {
      const dirty = !/^<[^<>]*>$/.test(p) && scanHygiene({ paths: [p], denylist }).length > 0;
      cache.set(p, dirty ? `<path:${hashText(p)}>` : p);
    }
    return cache.get(p);
  };
  return findings.map((f) => ({ ...f, path: show(f.path) }));
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function validateIssue(issue) {
  if (!issue || typeof issue !== 'object' || !validGlobList(issue.allowedPaths)) throw new GateSignal('G0-INPUT');
  if (issue.allowChanges !== undefined && (issue.allowChanges === null || typeof issue.allowChanges !== 'object')) throw new GateSignal('G0-INPUT');
}

function validateBaseline(b) {
  if (b === undefined) return { cjkPathAllowlist: [], testFakes: [], frozenTokens: [], templates: undefined };
  if (b === null || typeof b !== 'object') throw new GateSignal('G0-INPUT');
  const list = (x) => (x === undefined ? [] : x);
  const out = { cjkPathAllowlist: list(b.cjkPathAllowlist), testFakes: list(b.testFakes), frozenTokens: list(b.frozenTokens), templates: b.templates };
  if (!validGlobList(out.cjkPathAllowlist) || !Array.isArray(out.testFakes) || !Array.isArray(out.frozenTokens)
    || !out.frozenTokens.every((t) => typeof t === 'string')) throw new GateSignal('G0-INPUT');
  return out;
}

function blockResult(code) {
  return { verdict: 'block', findings: [], blocks: [{ ruleId: code }] };
}

async function execute(opts, deadline) {
  validateIssue(opts.issue);
  const issue = opts.issue;
  const runnerTimeoutMs = opts.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
  if (!Number.isFinite(runnerTimeoutMs) || runnerTimeoutMs <= 0) throw new GateSignal('G0-INPUT');

  const ctx = opts.diff ? { ...normalizeDiff(opts.diff), gitMeta: undefined }
    : { ...(await collectGitDiff({ root: opts.root, baseRef: opts.baseRef })) };
  const { files } = ctx;
  const base = ctx.base || {};
  const baseline = validateBaseline(opts.baseline !== undefined ? opts.baseline : base.baseline);
  const templates = baseline.templates ?? base.templates ?? [];

  const metadata = { ...(opts.metadata || {}) };
  if (ctx.gitMeta) {
    if (metadata.commitMessages === undefined) metadata.commitMessages = ctx.gitMeta.commitMessages;
    if (metadata.authors === undefined) metadata.authors = ctx.gitMeta.authors;
  }

  const findings = [];
  const blocks = [];
  const addBlock = (code) => { if (!blocks.some((b) => b.ruleId === code)) blocks.push({ ruleId: code }); };
  const expired = () => Date.now() > deadline;
  // The deadline is enforced between steps: an over-time run can never pass.
  const step = async (fn) => {
    if (expired()) { addBlock('G0-TIMEOUT'); return; }
    try { const out = await fn(); if (out) findings.push(...out); } catch (err) { addBlock(blockCodeOf(err)); }
    if (expired()) addBlock('G0-TIMEOUT');
  };

  // Host-run inputs: PR metadata must be supplied, otherwise it would silently go unscanned.
  if (opts.hostRun === true) {
    const m = opts.metadata || {};
    if (typeof m.prTitle !== 'string' || typeof m.prBody !== 'string' || typeof m.branch !== 'string') addBlock('G0-METADATA');
  }

  // Rule 2
  await step(() => checkScope(files, issue));
  // Rule 1 (static)
  await step(() => checkTestIntegrity(files, issue));
  // Rule 1 (run base command)
  await step(async () => {
    if (opts.hostRun === true && opts.networkIsolated !== true) throw new GateSignal('G0-NETWORK');
    let basePackage;
    try { basePackage = JSON.parse(String(base.packageJson)); } catch { throw new GateSignal('G0-INPUT'); }
    const scripts = basePackage && typeof basePackage.scripts === 'object' && basePackage.scripts ? basePackage.scripts : {};
    if (typeof scripts.test !== 'string' || !scripts.test.trim()) throw new GateSignal('G0-INPUT');
    const runner = opts.runner || (opts.diff ? undefined : defaultRunner);
    if (typeof runner !== 'function') throw new GateSignal('G0-INPUT');
    const controller = new AbortController();
    const baseFiles = { 'package.json': String(base.packageJson) };
    const spec = {
      root: opts.root, baseRef: opts.baseRef, command: scripts.test, scripts,
      basePackage, engines: basePackage.engines || {}, env: buildRunnerEnv(opts.env || process.env),
      timeoutMs: runnerTimeoutMs, signal: controller.signal, depsDir: opts.depsDir, baseFiles,
      networkIsolated: opts.networkIsolated === true,
    };
    const result = await withTimeout(() => Promise.resolve(runner(spec)), runnerTimeoutMs, controller);
    if (!result || typeof result !== 'object') throw new GateSignal('G0-RUNNER');
    if (result.timedOut === true) throw new GateSignal('G0-TIMEOUT');
    if (!Number.isInteger(result.exitCode)) throw new GateSignal('G0-RUNNER');
    return result.exitCode === 0 ? [] : [mk('G0-TESTS', '<tests>', 0, String(result.exitCode))];
  });
  // Rules 3 and 4 need the registry
  let registry;
  await step(() => {
    registry = buildRegistry({ verdictSource: base.verdictSource, templates, extras: baseline.frozenTokens });
    return [];
  });
  if (registry) {
    await step(() => checkFrozenTokens(files, registry));
    await step(() => checkDirection(files, registry, baseline.cjkPathAllowlist));
  }
  // Rules 5-6
  let denylist;
  try {
    denylist = loadDenylist({ env: opts.env || process.env, hostRun: opts.hostRun === true, fixture: opts.denylist });
  } catch (err) {
    addBlock(blockCodeOf(err));
  }
  if (denylist) await step(() => collectHygiene(files, metadata, denylist, baseline, deadline));

  let redacted;
  try { redacted = redactPaths(findings, denylist || EMPTY_DENYLIST); } catch { addBlock('G0-INTERNAL'); redacted = []; }
  const verdict = blocks.length ? 'block' : redacted.length ? 'reject' : 'pass';
  return { verdict, findings: redacted, blocks };
}

/**
 * Run Gate 0. Never throws: any internal error, timeout or missing input is a
 * block whose message is a rule ID only. Returns { verdict, findings, blocks }.
 */
export async function runGate0(opts = {}) {
  const timeoutMs = opts && opts.timeoutMs !== undefined ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return blockResult('G0-INPUT');
  const started = Date.now();
  const deadline = started + timeoutMs;
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(blockResult('G0-TIMEOUT')), timeoutMs);
    if (timer.unref) timer.unref();
  });
  try {
    const result = await Promise.race([execute(opts || {}, deadline), guard]);
    // A CPU-bound step blocks the timer, so the guard alone cannot fire: never pass late.
    if (Date.now() > deadline) return blockResult('G0-TIMEOUT');
    return result;
  } catch (err) {
    return blockResult(blockCodeOf(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Human-readable, redacted rendering of a result. */
export function formatResult(result) {
  const lines = [`gate0: ${result.verdict}`];
  for (const b of result.blocks) lines.push(`BLOCK ${/^[A-Z0-9-]+$/.test(String(b.ruleId)) ? b.ruleId : 'G0-INTERNAL'}`);
  const body = formatFindings(result.findings);
  if (body) lines.push(body);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function main(argv = process.argv.slice(2)) {
  const opts = {};
  let issuePath;
  let metaPath;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--root') opts.root = argv[++i];
      else if (a === '--base') opts.baseRef = argv[++i];
      else if (a === '--issue') issuePath = argv[++i];
      else if (a === '--metadata') metaPath = argv[++i];
      else if (a === '--host-run') opts.hostRun = true;
      else if (a === '--network-isolated') opts.networkIsolated = true;
      else if (a === '--deps-dir') opts.depsDir = argv[++i];
      else if (a === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
      else throw new GateSignal('G0-INPUT');
    }
    if (!issuePath) throw new GateSignal('G0-INPUT');
    opts.issue = await readJson(issuePath);
    if (metaPath) opts.metadata = await readJson(metaPath);
  } catch {
    const r = blockResult('G0-INPUT');
    process.stdout.write(`${JSON.stringify(r)}\n`);
    return 2;
  }
  const result = await runGate0(opts);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.verdict === 'pass' ? 0 : result.verdict === 'reject' ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
