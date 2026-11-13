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
//   1 Tests        G0-TESTS, G0-TEST-COUNT, G0-TEST-SKIP; G0-TESTS-SKIPPED-SCOPE (block: the
//                  tests are not run when the diff has a symlink, a submodule or an out-of-scope path)
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
//   denylist | hostRun   fixture denylist (non-host runs only; ignored on a host run), or
//                        load from $RT_HOME (outside the repo)
//                        The CLI defaults to host-run (production) semantics; see below.
//   runner               injected async test runner (see `defaultRunner`)
//   baseline             { cjkPathAllowlist, testFakes, frozenTokens, templates }
//                        in git mode read from `runtime/gate0-baseline.json` at the base
//                        only (a caller-supplied value is ignored); injectable in diff mode
//   timeoutMs, runnerTimeoutMs, networkIsolated, depsDir, env
//   (in diff mode)       base: { packageJson, lockfile, templates, sharedPrompt, verdictSource, baseline }
//
// Production semantics (host run). The CLI is a host run unless `--local` (alias
// `--no-host-run`) is given: the denylist from $RT_HOME is required, the caller must
// assert `--network-isolated`, and PR title / body / branch metadata must be supplied.
// Any missing item is a block. `--local` is meant for local experiments and tests: it can
// run the submitted tests with network access and without a denylist, so its output is
// marked non-authoritative and must never be used as a gate result. The library entry
// point `runGate0` keeps `hostRun` explicit (fixtures inject a denylist).
//
// Supplied metadata is additive: in git mode the real commit messages and the author and
// committer identities of merge-base..HEAD are always collected from git, and the union of
// the git-derived and the supplied values is scanned. Supplied values can never hide
// anything that git reports.
//
// No-network enforcement: pure Node cannot sandbox the network. What this module
// does: the test runner gets a scrubbed environment (no proxy, no registry, no
// credentials, npm forced offline), only `node` steps are executed (no shell),
// and a host run (`hostRun: true`) that does not assert `networkIsolated: true`
// (the host runs Gate 0 inside a network-less namespace) is a BLOCK.
//
// Dependencies: when the base declares dependencies or has a lockfile, the host-supplied
// `depsDir` must carry the lockfile it was installed from as `<depsDir>/package-lock.json`,
// and its sha256 must equal the base lockfile blob. A missing or different copy is a block
// (`G0-DEPS`).
//
// Known limitations (documented on purpose):
//   - Frozen English tokens such as `done` or `review` are ordinary words; the
//     check is a per-file word-boundary count that must not decrease, so
//     rewording prose that contains them can be a false reject.
//   - Frozen Chinese tokens are counted only when not adjacent to another Han
//     character, so ordinary Chinese prose that merely contains them is ignored.
//   - Test-case counting is static and heuristic: comments and string / template /
//     regex literal contents are stripped, then test( / it( calls are counted. It does
//     not execute code, so a call that is dead, conditional or generated is still counted
//     once; the base test command run is the authority on what actually executes.
//   - Disable markers (skip / only / pending forms) are matched on added lines of every
//     file, so a prose use of one of those words can be a false reject (allowSkip in the
//     issue overrides).
//   - The frozen-token registry is a union of base-side sources (verdict probes, template
//     bullets and placeholders, backticked words in the shared prompt vocabulary section,
//     `baseline.frozenTokens`, a built-in list). It is conservative, not a proof that
//     every machine field is covered.

import { execFile, spawn } from 'node:child_process';
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { loadDenylist, scanHygiene, hashText, formatFindings, HygieneError } from './hygiene.mjs';

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const BASELINE_PATH = 'runtime/gate0-baseline.json';
export const TEMPLATES_DIR = '.agents/skills/roundtable-work/templates/';
export const SHARED_PROMPT_PATH = '.agents/skills/roundtable-work/prompts/shared.md';
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_RUNNER_TIMEOUT_MS = 300000;
const MAX_BUFFER = 256 * 1024 * 1024;
const OUTPUT_CAP = 16 * 1024 * 1024;

// CJK words are built from numeric code points so no escape sequence that decodes to CJK
// text appears in this source (the gate scans decoded views of every added line).
const fromCodes = (...codes) => String.fromCodePoint(...codes);
const ZH = Object.freeze({
  VERDICT_PASS: fromCodes(0x901a, 0x8fc7),
  REJECT: fromCodes(0x6253, 0x56de),
  BLOCK: fromCodes(0x963b, 0x585e),
  COMPLETE: fromCodes(0x5b8c, 0x6210),
  PARTIAL: fromCodes(0x90e8, 0x5206, 0x5b8c, 0x6210),
  FAILED: fromCodes(0x5931, 0x8d25),
  UNKNOWN: fromCodes(0x672a, 0x77e5),
  REVIEW_LABEL: fromCodes(0x5ba1, 0x67e5, 0x7ed3, 0x8bba),
  EXECUTED: fromCodes(0x5df2, 0x6267, 0x884c),
  READ: fromCodes(0x5df2, 0x8bfb, 0x53d6),
  SELF_REPORTED: fromCodes(0x81ea, 0x8ff0),
  NOT_RUN: fromCodes(0x672a, 0x8fd0, 0x884c),
});
const FULLWIDTH_COLON = fromCodes(0xff1a);

// Unicode script properties cover halfwidth kana, jamo, compatibility ideographs and
// the astral Han extensions. The source stays ASCII.
const HAN = '\\p{Script=Han}';
const CJK_ALT = `${HAN}|\\p{Script=Bopomofo}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}`;
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
// Conservative built-in machine field names (a safety net when a base-side source is absent):
// evidence-level words and the issue-card field names used by the machine contracts.
const DEFAULT_FIELD_NAMES = [
  ZH.EXECUTED, ZH.READ, ZH.SELF_REPORTED, ZH.NOT_RUN,
  'allowedPaths', 'allowChanges', 'allowSkip',
];
// Protected categories: out of scope unless the issue explicitly allows them.
const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const CI_PATTERNS = ['.github/**', '.github/*', '.gitlab-ci.yml', '.circleci/**', '.nvmrc', '.node-version'];
const under = (p, dir) => p === dir.replace(/\/$/, '') || p.startsWith(dir);
const PROTECTED = [
  { flag: 'gate0', test: (p) => under(p, 'runtime/') || under(p, 'test/runtime/') },
  { flag: 'verdict', test: (p) => p === 'lib/verdict.mjs' },
  { flag: 'allowlists', test: (p) => p === BASELINE_PATH },
  { flag: 'packageJson', test: (p) => baseName(p) === 'package.json' },
  { flag: 'lockfiles', test: (p) => LOCKFILE_NAMES.includes(baseName(p)) },
  { flag: 'ci', test: (p) => CI_PATTERNS.some((g) => globToRegExp(g).test(p)) },
  // Check scripts, hooks and tool configuration that could wrap or skip Gate 0 (T-04).
  { flag: 'scripts', test: (p) => under(p, 'scripts/') },
  { flag: 'gitconfig', test: (p) => ['.gitattributes', '.gitmodules', '.gitignore', '.npmrc', '.mocharc.json', '.mocharc.js', '.mocharc.cjs', '.mocharc.yml'].includes(baseName(p))
    || baseName(p).startsWith('.yarnrc') || under(p, '.husky/') || under(p, '.githooks/') },
  { flag: 'templates', test: (p) => under(p, TEMPLATES_DIR) || p === SHARED_PROMPT_PATH || p === '.roundtable/policy.md' },
  { flag: 'nodeModules', test: (p) => p.split('/').includes('node_modules') },
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
    if (err.code === 'LIMIT') return 'G0-LIMIT';
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
 * Derive the verdict forms STATICALLY from the BASE text of the verdict module. No file of
 * the reviewed tree is imported or evaluated. The module is a chain of
 * `normalized === '<literal>'` comparisons each followed by `return '<class>'`; those pairs are
 * extracted with a regular expression. The built-in probe list is the required minimum:
 * a base source that yields verdict-shaped pairs but lacks a required form is a block
 * (G0-REGISTRY); a source with no such pairs (or no source) falls back to the built-in list.
 * Returns { tokens, chinese: {passed, rejected, blocked} }.
 */
export function deriveVerdictTokens(verdictSource) {
  const found = new Map();
  if (typeof verdictSource === 'string' && verdictSource.length <= 200000) {
    const re = /normalized\s*===\s*(['"])([^'"\\\n]{1,32})\1\s*\)\s*\{\s*return\s*(['"])([a-z]{1,16})\3/g;
    for (const m of verdictSource.matchAll(re)) found.set(m[2].trim(), m[4]);
  }
  const builtIn = new Map([
    [ZH.VERDICT_PASS, 'passed'], [ZH.REJECT, 'rejected'], [ZH.BLOCK, 'blocked'],
    ['passed', 'passed'], ['rejected', 'rejected'], ['blocked', 'blocked'], ['returned', 'rejected'],
  ]);
  if (found.size > 0) {
    for (const [lit, cls] of builtIn) if (found.get(lit) !== cls) throw new GateSignal('G0-REGISTRY');
  } else {
    for (const [lit, cls] of builtIn) found.set(lit, cls);
  }
  const tokens = [...found.keys()];
  const chinese = {};
  for (const [lit, cls] of found) if (hasCjk(lit) && chinese[cls] === undefined) chinese[cls] = lit;
  if (!chinese.passed || !chinese.rejected || !chinese.blocked) throw new GateSignal('G0-REGISTRY');
  return { tokens, chinese };
}

/**
 * Field labels and placeholders from base templates, regardless of heading:
 * every `- label:` / `- label (...)` bullet and every `<...>` placeholder.
 */
export function deriveTemplateTokens(templates) {
  const tokens = new Set();
  const addLabel = (raw) => {
    let name = raw.split(' (')[0].split(', ')[0].trim();
    name = name.replace(/^`|`$/g, '').replace(/^\*\*|\*\*$/g, '').trim();
    if (name.length >= 2 && name.length <= 80) tokens.add(name);
  };
  for (const t of Array.isArray(templates) ? templates : []) {
    if (!t || typeof t.content !== 'string') continue;
    for (const line of t.content.split(/\r?\n/)) {
      const label = /^\s*[-*]\s+(.+?):(?:\s|$)/.exec(line);
      if (label) addLabel(label[1]);
      else {
        const paren = /^\s*[-*]\s+([^:()\n]{2,40}?)\s+\([^()\n]*\)\s*$/.exec(line);
        if (paren && paren[1].trim().split(/\s+/).length <= 4) addLabel(paren[1]);
      }
      for (const ph of line.matchAll(/<[^<>\n]{1,40}>/g)) tokens.add(ph[0]);
    }
  }
  return [...tokens];
}

const VOCAB_HEADING_RE = new RegExp(
  `^#{1,6}\\s.*(?:status\\s+vocabulary|${fromCodes(0x72b6, 0x6001, 0x8bcd, 0x6c47)}|${fromCodes(0x7edf, 0x4e00, 0x8bcd, 0x6c47)})`,
  'i',
);

/**
 * Backticked machine words in the status-vocabulary section of the base shared prompt
 * (ticket statuses, delegation events, delivery statuses, continuation words, evidence levels).
 */
export function deriveSharedPromptTokens(text) {
  const tokens = new Set();
  if (typeof text !== 'string') return [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) { inSection = VOCAB_HEADING_RE.test(line); continue; }
    if (!inSection) continue;
    for (const span of line.matchAll(/`([^`\n]{1,200})`/g)) {
      for (const word of span[1].split(/[\s\u2192/|,;+]+|->|=>/)) {
        const w = word.trim();
        if (/^[A-Za-z][A-Za-z0-9_]+$/.test(w) || new RegExp(`^${HAN}{2,}$`, 'u').test(w)) tokens.add(w);
      }
    }
  }
  return [...tokens];
}

/**
 * Build the frozen-token registry.
 * Returns { tokens: string[], verdictLine: RegExp (global) }.
 */
export function buildRegistry({ verdictSource, templates, sharedPrompt, extras } = {}) {
  const verdict = deriveVerdictTokens(verdictSource);
  const set = new Set([
    ...TICKET_STATUS_WORDS, ...DELIVERY_STATUS_WORDS, ...CONTINUATION_WORDS,
    ZH.REVIEW_LABEL, ...verdict.tokens, ...DEFAULT_FIELD_NAMES,
    ...deriveTemplateTokens(templates),
    ...deriveSharedPromptTokens(sharedPrompt),
    ...(Array.isArray(extras) ? extras.filter((x) => typeof x === 'string' && x.length > 0) : []),
  ]);
  const tokens = [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
  const { passed, rejected, blocked } = verdict.chinese;
  // An English parenthetical after a frozen token is allowed.
  const tok = (t) => `${escapeRe(t)}(?:[ \\t]*\\([^()\\n]*\\))?`;
  const core = `${ZH.REVIEW_LABEL}[:${FULLWIDTH_COLON}][ \\t]*${tok(passed)}[ \\t]*\\|[ \\t]*${tok(rejected)}[ \\t]*\\|[ \\t]*${tok(blocked)}`;
  // Anchored: the contract line is a whole line (optional list marker and backticks), or a
  // backticked span. A copy in the middle of a sentence, with trailing text, or behind an
  // invisible character is not a verdict line.
  const verdictLine = new RegExp(`^[ \\t]*(?:[-*>][ \\t]+)?\`?${core}\`?[ \\t]*$|\`${core}\``, 'gm');
  const verdictLabel = ZH.REVIEW_LABEL;
  return { tokens, verdictLine, verdictLabel };
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

const substringReCache = new Map();
/**
 * Occurrences for the frozen-token invariant. Chinese tokens are counted as plain
 * substrings (also when embedded in or adjacent to other Han text), so a machine field
 * inside Chinese prose cannot be renamed unnoticed. Other tokens use countToken rules.
 */
export function countTokenForInvariant(text, token) {
  if (!hasCjk(token)) return countToken(text, token);
  let re = substringReCache.get(token);
  if (!re) { re = new RegExp(escapeRe(token), 'gu'); substringReCache.set(token, re); }
  return countRegex(text, re);
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
      symlink: f.oldMode === '120000' || f.newMode === '120000',
      lfs: f.lfs === true,
      badPath: f.badPath === true,
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
// Git collection (hardened execFile, no shell, no repo-config-driven behavior)
// ---------------------------------------------------------------------------

// Fixed git environment: no system or global config, no replace objects, no attribute
// files, literal pathspecs, no prompts. The reviewed repository can still carry local
// config and `.git/info/attributes`; every call below also pins the settings that matter
// on the command line, and blobs are read by object id (no attribute processing at all).
const GIT_ENV_FIXED = Object.freeze({
  LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_ATTR_NOSYSTEM: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_COUNT: '0',
});
const GIT_PINNED = [
  '--no-replace-objects', '--no-pager',
  '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat', '-c', 'diff.external=',
  '-c', 'protocol.allow=never', '-c', 'core.autocrlf=false', '-c', 'core.untrackedCache=false',
];
const MAX_BLOB = 4 * 1024 * 1024;
const MAX_MD_LINE = 2000;
const ZERO_SHA = /^0+$/;

function gitEnv() {
  return { PATH: process.env.PATH || '', ...GIT_ENV_FIXED };
}

/** Run git and return a Buffer (never decoded lossily). Failure => G0-GIT. */
async function gitBuf(root, args, { allowFail = false } = {}) {
  try {
    const { stdout } = await execFileP('git', [...GIT_PINNED, ...args], {
      cwd: root, maxBuffer: MAX_BUFFER, encoding: 'buffer', env: gitEnv(),
    });
    return stdout;
  } catch {
    if (allowFail) return undefined;
    throw new GateSignal('G0-GIT');
  }
}

async function git(root, args, opts) {
  const out = await gitBuf(root, args, opts);
  return out === undefined ? undefined : out.toString('utf8');
}

/** Read blobs by object id in one `cat-file --batch` process. Returns Map(sha -> Buffer). */
export function readBlobs(root, shas) {
  const unique = [...new Set(shas)];
  return new Promise((resolve, reject) => {
    if (unique.length === 0) { resolve(new Map()); return; }
    const child = spawn('git', [...GIT_PINNED, 'cat-file', '--batch'], { cwd: root, env: gitEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    let total = 0;
    child.stdout.on('data', (c) => {
      total += c.length;
      if (total > MAX_BUFFER) { child.kill(); reject(new GateSignal('G0-LIMIT')); return; }
      chunks.push(c);
    });
    child.on('error', () => reject(new GateSignal('G0-GIT')));
    child.on('close', () => {
      try {
        const buf = Buffer.concat(chunks);
        const out = new Map();
        let pos = 0;
        for (const sha of unique) {
          const nl = buf.indexOf(0x0a, pos);
          if (nl < 0) throw new GateSignal('G0-GIT');
          const m = /^([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(buf.subarray(pos, nl).toString('latin1'));
          if (!m || m[1] !== sha || m[2] !== 'blob') throw new GateSignal('G0-GIT');
          const size = Number(m[3]);
          if (size > MAX_BLOB) throw new GateSignal('G0-LIMIT');
          out.set(sha, buf.subarray(nl + 1, nl + 1 + size));
          pos = nl + 1 + size + 1;
        }
        resolve(out);
      } catch (err) { reject(err); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${unique.join('\n')}\n`);
  });
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
function decodeStrict(buf) {
  try { return UTF8_STRICT.decode(buf); } catch { return undefined; }
}
/** Escape a non-UTF-8 name into a printable ASCII form (contains a backslash on purpose). */
function escapeBytes(buf) {
  let s = '';
  for (const b of buf) s += b >= 0x21 && b <= 0x7e && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`;
  return s;
}
const LFS_HEADER = 'version https://git-lfs.github.com/spec/v1';
// Total characters of printable runs (all views) one binary blob may contribute. Runs are never
// truncated or dropped: above the cap the gate blocks (G0-LIMIT). The hygiene scanner splits
// long runs into overlapping windows itself, so a run of any length below the cap is scanned whole.
const MAX_BINARY_CHARS = 4 * 1024 * 1024;

/**
 * Printable runs of a binary blob (strings(1) style, UTF-8 and UTF-16LE views), as
 * pseudo added lines, so text hiding inside binary content is scanned (never skipped, never
 * truncated). Fails closed (G0-LIMIT) when the runs add up to more than MAX_BINARY_CHARS.
 */
export function binaryStrings(buf, maxChars = MAX_BINARY_CHARS) {
  const views = [buf.toString('utf8'), buf.toString('utf16le'), buf.subarray(1).toString('utf16le')];
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const v of views) {
    for (const seg of v.split(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]+/)) {
      if (seg.length < 4 || seen.has(seg)) continue;
      seen.add(seg);
      total += seg.length;
      if (total > maxChars) throw new GateSignal('G0-LIMIT');
      out.push({ line: out.length + 1, text: seg });
    }
  }
  return out;
}

/** Ordered line diff; retain unchanged lines only when their order is preserved. */
export function lineDelta(baseText, headText) {
  const split = (t) => (t === '' ? [] : t.replace(/\r$/gm, '').split('\n'));
  const b = split(baseText), h = split(headText);
  if (b.length * h.length > 4000000) throw new GateSignal('G0-LIMIT');
  const dp = Array.from({ length: b.length + 1 }, () => new Uint32Array(h.length + 1));
  for (let i = b.length - 1; i >= 0; i--) for (let j = h.length - 1; j >= 0; j--) {
    dp[i][j] = b[i] === h[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const added = [], removed = [];
  let i = 0, j = 0;
  while (i < b.length || j < h.length) {
    if (i < b.length && j < h.length && b[i] === h[j]) { i++; j++; }
    else if (j === h.length || (i < b.length && (dp[i + 1][j] > dp[i][j + 1] || (dp[i + 1][j] === dp[i][j + 1] && HAS_CJK_RE.test(b[i]))))) removed.push({ line: ++i, text: b[i - 1] });
    else added.push({ line: ++j, text: h[j - 1] });
  }
  return { added, removed };
}

/** Parse `git diff --raw -z --full-index` output into entries with Buffer-safe paths. */
function parseRaw(out) {
  const toks = [];
  let start = 0;
  for (let i = 0; i < out.length; i++) if (out[i] === 0) { toks.push(out.subarray(start, i)); start = i + 1; }
  const entries = [];
  for (let i = 0; i < toks.length; i++) {
    const meta = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(toks[i].toString('latin1'));
    if (!meta) throw new GateSignal('G0-GIT');
    const e = { oldMode: meta[1], newMode: meta[2], oldSha: meta[3], newSha: meta[4], status: meta[5] };
    const take = () => {
      const raw = toks[++i];
      if (raw === undefined) throw new GateSignal('G0-GIT');
      const s = decodeStrict(raw);
      return s === undefined ? { text: escapeBytes(raw), bad: true } : { text: s, bad: false };
    };
    if (e.status === 'R' || e.status === 'C') {
      const o = take(); const n = take();
      Object.assign(e, { oldPath: o.text, path: n.text, badPath: o.bad || n.bad });
    } else {
      const n = take();
      Object.assign(e, { path: n.text, badPath: n.bad });
    }
    entries.push(e);
  }
  return entries;
}

/** Build the content model of a changed entry from its blobs (text/binary decided here). */
function modelEntry(e, blobs) {
  const baseBuf = e.oldMode !== '000000' && e.oldMode !== '160000' && !ZERO_SHA.test(e.oldSha) ? blobs.get(e.oldSha) : undefined;
  const headBuf = e.newMode !== '000000' && e.newMode !== '160000' && !ZERO_SHA.test(e.newSha) ? blobs.get(e.newSha) : undefined;
  const side = (buf) => {
    if (!buf) return { text: '', binary: false, lfs: false, strings: [] };
    const hasNul = buf.includes(0);
    const text = hasNul ? undefined : decodeStrict(buf);
    if (text === undefined) return { text: '', binary: true, lfs: false, strings: binaryStrings(buf) };
    return { text, binary: false, lfs: text.startsWith(LFS_HEADER), strings: [] };
  };
  const b = side(baseBuf);
  const h = side(headBuf);
  const binary = b.binary || h.binary;
  const symlink = e.newMode === '120000' || e.oldMode === '120000';
  let added; let removed;
  if (binary) {
    added = h.strings; removed = b.strings;
  } else {
    ({ added, removed } = lineDelta(b.text, h.text));
  }
  return { binary, lfs: h.lfs || b.lfs, symlink, added, removed, baseContent: b.text, headContent: h.text };
}

const SHA_RE = /^[0-9a-f]{40,64}$/;
const REF_RE = /^[A-Za-z0-9._/~^@-]{1,200}$/;

async function resolveCommit(root, ref) {
  const out = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  if (!SHA_RE.test(out)) throw new GateSignal('G0-GIT');
  return out;
}

/** Re-resolve HEAD: used at the end of a run to detect a moved head (G0-RACE). */
export async function resolveHead(root) {
  return resolveCommit(root, 'HEAD');
}

/** Parse a raw commit object: structural header/body split, no in-band delimiters. */
export function parseCommitObject(buf) {
  const text = buf.toString('utf8');
  const cut = text.indexOf('\n\n');
  const headerText = cut < 0 ? text : text.slice(0, cut);
  const message = cut < 0 ? '' : text.slice(cut + 2);
  const headers = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation (signature blocks, merge tags)
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    if (key === 'tree' || key === 'parent' || key === 'gpgsig' || key === 'gpgsig-sha256' || key === 'mergetag') continue;
    headers.push(sp < 0 ? '' : line.slice(sp + 1).replace(/ \d+ [+-]\d{4}$/, ''));
  }
  return { headers: headers.filter(Boolean), message };
}

/**
 * Compute the diff model from git: merge-base(baseRef, HEAD) .. HEAD, with refs resolved
 * once to SHAs. Also collects every commit in the range (messages, identities, extra headers,
 * and the lines each commit added, merges against each parent) so content that exists only in
 * an intermediate commit is still scanned.
 */
export async function collectGitDiff({ root, baseRef, headSha: pinnedHead }) {
  if (typeof root !== 'string' || !root || typeof baseRef !== 'string' || !REF_RE.test(baseRef)
    || baseRef.startsWith('-') || baseRef.startsWith('^')) {
    throw new GateSignal('G0-INPUT');
  }
  const headSha = pinnedHead || await resolveCommit(root, 'HEAD');
  const baseTip = await resolveCommit(root, baseRef);
  const bases = (await git(root, ['merge-base', '--all', '--end-of-options', baseTip, headSha])).split('\n').filter(Boolean);
  if (bases.length !== 1 || !SHA_RE.test(bases[0])) throw new GateSignal('G0-GIT');
  const mergeBase = bases[0];

  // Dirty or untracked state: the reviewed commit is not what is on disk => block.
  const status = await gitBuf(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=no']);
  if (status.length > 0) throw new GateSignal('G0-DIRTY');

  const rawOut = await gitBuf(root, ['diff', '--raw', '-z', '--no-abbrev', '--find-renames', '--no-textconv', '--no-ext-diff', '--no-color', mergeBase, headSha, '--']);
  const entries = parseRaw(rawOut);
  const wanted = [];
  for (const e of entries) {
    for (const s of [e.oldSha, e.newSha]) if (!ZERO_SHA.test(s) && e.oldMode !== '160000' && e.newMode !== '160000') wanted.push(s);
  }
  const blobs = await readBlobs(root, wanted);
  const files = entries.map((e) => {
    const m = modelEntry(e, blobs);
    return { ...e, ...m, status: e.status };
  });

  const showBase = async (p) => {
    const out = await gitBuf(root, ['show', `${mergeBase}:${p}`], { allowFail: true });
    return out === undefined ? undefined : out.toString('utf8');
  };
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

  // History: every commit in the range, raw objects parsed structurally.
  const revs = (await git(root, ['rev-list', '--reverse', '--topo-order', `${mergeBase}..${headSha}`, '--'])).split('\n').filter(Boolean);
  if (revs.length > 2000 || !revs.every((r) => SHA_RE.test(r))) throw new GateSignal('G0-LIMIT');
  const commitMessages = [];
  const authors = [];
  const historyAdded = [];
  const seenLines = new Set();
  for (const f of files) for (const l of f.added) seenLines.add(`${f.path}\0${l.text}`);
  for (const sha of revs) {
    const obj = parseCommitObject(await gitBuf(root, ['cat-file', 'commit', sha]));
    commitMessages.push(obj.message);
    authors.push(...obj.headers);
    const dt = await gitBuf(root, ['diff-tree', '-r', '-m', '--root', '--no-commit-id', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-textconv', '--no-ext-diff', sha, '--']);
    const hEntries = dt.length ? parseRaw(dt) : [];
    const ids = [];
    for (const e of hEntries) {
      if (e.newMode === '160000' || e.oldMode === '160000') continue;
      for (const s of [e.oldSha, e.newSha]) if (!ZERO_SHA.test(s)) ids.push(s);
    }
    const hb = await readBlobs(root, ids);
    for (const e of hEntries) {
      if (e.newMode === '000000' || e.newMode === '160000' || e.oldMode === '160000') continue;
      const m = modelEntry(e, hb);
      for (const l of m.added) {
        const key = `${e.path}\0${l.text}`;
        if (seenLines.has(key)) continue;
        seenLines.add(key);
        historyAdded.push({ path: e.path, line: l.line, text: l.text });
      }
    }
  }

  return {
    files,
    base: {
      packageJson: await showBase('package.json'),
      lockfile: (await showBase('package-lock.json')) ?? (await showBase('npm-shrinkwrap.json')),
      sharedPrompt: await showBase(SHARED_PROMPT_PATH),
      verdictSource: await showBase('lib/verdict.mjs'),
      templates,
      baseline,
    },
    gitMeta: { commitMessages, authors, historyAdded },
    shas: { base: mergeBase, head: headSha },
  };
}

// ---------------------------------------------------------------------------
// Rule 1: tests
// ---------------------------------------------------------------------------

const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__)\/.*\.[cm]?[jt]s$|\.(?:test|spec)\.[cm]?[jt]s$|(?:^|\/)(?:test|[^/]*[-_]test|test-[^/]*)\.[cm]?[js]s?$/;

export function isTestFile(path) {
  return TEST_FILE_RE.test(path) && !/(?:^|\/)fixtures\//.test(path);
}

// Built from pieces so this file does not trip its own skip scan.
// Covers the dotted forms, the plain words and the option-object forms (with or without a value).
// Name of the pending-test counter, built from pieces for the same reason.
const PENDING_KEY = `${'to'}do`;
const SKIP_RE = new RegExp(
  [
    `\\.${'sk'}ip\\b`, `\\.${'on'}ly\\b`, `\\b${'to'}do\\b`, `\\b${'x'}it\\b`,
    `\\b${'sk'}ip["']?\\s*:`, `\\b${'on'}ly["']?\\s*:`, `\\{\\s*${'sk'}ip\\b`, `\\{\\s*${'on'}ly\\b`,
  ].join('|'),
  'i',
);
// Built from pieces for the same reason: modifier names are not written out literally.
const CASE_MODS = `(?:\\.(?:${'on'}ly|${'sk'}ip|${'to'}do))?`;
// Top-level `test(` / `it(` calls, plus Node subtests such as `t.test('name', ...)` and
// `t.it(...)`: a `<ident>.test(` / `<ident>.it(` call whose first argument is a string or
// template literal, or a name followed by a comma (so `re.test(value)` and `obj.test(1)` are not
// counted). `describe(` is not a case and is not matched.
const CASE_RE = new RegExp(
  `(?:^|[^\\w.$])(?:test|it)${CASE_MODS}\\s*\\(`
  + `|(?<![\\w.$])[A-Za-z_$][\\w$]*\\.(?:test|it)${CASE_MODS}\\s*\\(\\s*(?:['"\`]|[A-Za-z_$][\\w$]*\\s*,)`,
  'gm',
);
// Bracket and computed access to a modifier name: t['<word>'](...) or a concatenated literal.
const BRACKET_SKIP_RE = new RegExp(
  `\\[\\s*['"\`](?:${'sk'}ip|${'on'}ly|${'to'}do)['"\`]\\s*\\]|\\[\\s*['"\`][a-z]{0,6}['"\`]\\s*\\+\\s*['"\`][a-z]{0,6}['"\`]\\s*\\]`,
  'i',
);
const DYNAMIC_EVAL_RE = /\beval\s*\(|\bnew\s+Function\b/;
const MARKDOWN_RE = /\.(?:md|markdown|mdx)$/i;
const REGEX_PREV = '(,=:[!&|?{};+-*%<>~^';
const REGEX_WORDS = new Set(['return', 'typeof', 'case', 'delete', 'void', 'throw', 'in', 'of', 'new', 'else', 'do', 'yield', 'await']);

/**
 * Blank out comments and the contents of string, template and regex literals (newlines
 * and delimiters are kept) so a call that only appears in prose or data is not counted.
 * A small hand-written scanner: heuristic for regex-vs-division, no parsing of the language.
 */
export function stripNonCode(source) {
  const s = String(source);
  const n = s.length;
  const out = [];
  const blank = (ch) => (ch === '\n' || ch === '\r' ? ch : ' ');
  const tplStack = [];
  let braces = 0;
  let prev = '';
  let word = '';
  let i = 0;
  // Template body: runs to the closing backtick or to the next `${`.
  const template = () => {
    while (i < n) {
      const c = s[i];
      if (c === '\\') { out.push(' '); i++; if (i < n) { out.push(blank(s[i])); i++; } continue; }
      if (c === '`') { out.push(c); i++; prev = c; word = ''; return; }
      if (c === '$' && s[i + 1] === '{') { out.push('${'); i += 2; tplStack.push(braces); braces = 0; prev = '{'; word = ''; return; }
      out.push(blank(c)); i++;
    }
  };
  while (i < n) {
    const c = s[i];
    const d = s[i + 1];
    if (c === '/' && d === '/') { while (i < n && s[i] !== '\n') { out.push(' '); i++; } continue; }
    if (c === '/' && d === '*') {
      out.push('  '); i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) { out.push(blank(s[i])); i++; }
      if (i < n) { out.push('  '); i += 2; }
      continue;
    }
    if (c === '\'' || c === '"') {
      out.push(c); i++;
      while (i < n && s[i] !== c && s[i] !== '\n') {
        if (s[i] === '\\' && i + 1 < n && s[i + 1] !== '\n') { out.push('  '); i += 2; } else { out.push(' '); i++; }
      }
      if (i < n && s[i] === c) { out.push(c); i++; }
      prev = c; word = '';
      continue;
    }
    if (c === '`') { out.push(c); i++; template(); continue; }
    if (c === '{') { braces++; out.push(c); i++; prev = c; word = ''; continue; }
    if (c === '}') {
      out.push(c); i++; prev = c; word = '';
      if (braces === 0 && tplStack.length) { braces = tplStack.pop(); template(); } else if (braces > 0) braces--;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_PREV.includes(prev) || REGEX_WORDS.has(word))) {
      out.push(c); i++;
      let inClass = false;
      while (i < n && s[i] !== '\n' && (inClass || s[i] !== '/')) {
        if (s[i] === '\\' && i + 1 < n && s[i + 1] !== '\n') { out.push('  '); i += 2; continue; }
        if (s[i] === '[') inClass = true; else if (s[i] === ']') inClass = false;
        out.push(' '); i++;
      }
      if (i < n && s[i] === '/') { out.push('/'); i++; }
      prev = ')'; word = '';
      continue;
    }
    out.push(c); i++;
    if (/[A-Za-z0-9_$]/.test(c)) { word += c; prev = c; } else if (!/\s/.test(c)) { word = ''; prev = c; }
  }
  return out.join('');
}

export function countTestCases(content) {
  return countRegex(stripNonCode(content), CASE_RE);
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

function declaresDependencies(pkg) {
  const count = (o) => (o && typeof o === 'object' ? Object.keys(o).length : 0);
  return count(pkg.dependencies) + count(pkg.devDependencies) + count(pkg.optionalDependencies) > 0;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The host-supplied dependency directory must carry the lockfile it was installed from
 * (`<depsDir>/package-lock.json`) and that copy must equal the base lockfile.
 * No requirement when the base declares no dependencies and has no lockfile.
 */
export async function verifyDepsDir({ depsDir, baseLockfile, hasDeps }) {
  const hasLock = typeof baseLockfile === 'string';
  if (!hasDeps && !hasLock) return;
  if (depsDir === undefined || depsDir === null || depsDir === '') {
    if (hasDeps) throw new GateSignal('G0-DEPS');
    return;
  }
  if (typeof depsDir !== 'string' || !hasLock) throw new GateSignal('G0-DEPS');
  let supplied;
  try { supplied = await readFile(join(depsDir, 'package-lock.json'), 'utf8'); } catch { throw new GateSignal('G0-DEPS'); }
  if (sha256(supplied) !== sha256(baseLockfile)) throw new GateSignal('G0-DEPS');
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
 * Dependencies must be provided by the host as `depsDir` (base-lockfile install, carrying
 * `<depsDir>/package-lock.json` equal to the base lockfile); a base package that declares
 * dependencies without a matching `depsDir` is a block.
 * Output is never returned (it could carry identifiers): only the exit status.
 */
async function writeBaseFile(work, rel, content) {
  const target = join(work, rel);
  const inside = (p) => { const r = relative(work, p); return r !== '' && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
  if (!inside(target)) throw new GateSignal('G0-INPUT');
  // The submitted tree can contain a symlink at the target (or at a parent): remove whatever
  // sits there without following it, then create the file exclusively (`wx` fails on an
  // existing entry, including a dangling symlink).
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const realWork = await realpath(work);
  const realDir = await realpath(dir);
  if (realDir !== realWork && !(`${realDir}${sep}`).startsWith(`${realWork}${sep}`)) throw new GateSignal('G0-INPUT');
  try { await lstat(target); await rm(target, { recursive: true, force: true }); } catch (err) { if (!err || err.code !== 'ENOENT') throw err; }
  await writeFile(target, content, { flag: 'wx' });
}

export async function defaultRunner(spec) {
  if (!spec || typeof spec.root !== 'string') throw new GateSignal('G0-INPUT');
  const pkg = spec.basePackage || {};
  if (!nodeSatisfies(spec.engines && spec.engines.node)) throw new GateSignal('G0-NODE');
  const hasDeps = declaresDependencies(pkg);
  if (hasDeps && !spec.depsDir) throw new GateSignal('G0-DEPS');
  if (spec.depsDir) await verifyDepsDir({ depsDir: spec.depsDir, baseLockfile: spec.baseLockfile, hasDeps });
  const steps = resolveTestSteps(spec.scripts, spec.command);
  const tmp = await mkdtemp(join(tmpdir(), 'gate0-'));
  try {
    const work = join(tmp, 'work');
    await mkdir(work);
    await materializeTree(spec.root, spec.headSha, work);
    for (const [rel, content] of Object.entries(spec.baseFiles || {})) await writeBaseFile(work, rel, content);
    if (spec.depsDir) {
      // The submitted tree may carry its own `node_modules` entry: never write through it.
      await rm(join(work, 'node_modules'), { recursive: true, force: true });
      await symlink(spec.depsDir, join(work, 'node_modules'), 'dir');
    }
    const env = buildRunnerEnv(spec.env || process.env, tmp);
    const counts = { tests: 0, skipped: 0, [PENDING_KEY]: 0, cancelled: 0, subtests: 0 };
    let expectTests = false;
    for (const argv of steps) {
      const args = argv.slice(1);
      const ti = args.indexOf('--test');
      const reporting = ti >= 0 && !args.some((a) => a.startsWith('--test-reporter'));
      if (ti >= 0) expectTests = true;
      if (reporting) args.splice(ti + 1, 0, '--test-reporter=tap');
      try {
        const { stdout } = await execFileP(process.execPath, args, {
          cwd: work, env, timeout: spec.timeoutMs, signal: spec.signal, maxBuffer: OUTPUT_CAP,
        });
        if (reporting) {
          // Indented result lines are test cases inside a file; a file that registers none
          // (for example one that exits at once) still counts as one top-level "test".
          counts.subtests += (String(stdout).match(/^\s+(?:not )?ok \d+ - /gm) || []).length;
          for (const k of ['tests', 'skipped', PENDING_KEY, 'cancelled']) {
            const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(String(stdout));
            if (m) counts[k] += Number(m[1]);
          }
        }
      } catch (err) {
        if (err && (err.killed || err.name === 'AbortError')) return { exitCode: null, timedOut: true };
        if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { exitCode: 1, limit: true };
        return { exitCode: typeof err.code === 'number' ? err.code : 1 };
      }
    }
    return { exitCode: 0, counts, expectTests };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Write the tree of `headSha` into `work` with our own writer (no `git archive`: export
 * attributes of the reviewed tree cannot drop files). Regular files only; symlinks and
 * gitlinks are not materialized.
 */
async function materializeTree(root, headSha, work) {
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) throw new GateSignal('G0-INPUT');
  const listing = await gitBuf(root, ['ls-tree', '-r', '-z', '--full-tree', headSha]);
  const entries = [];
  for (const rec of listing.toString('utf8').split('\0')) {
    if (!rec) continue;
    const m = /^(\d+) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(rec);
    if (!m) throw new GateSignal('G0-GIT');
    if (m[2] !== 'blob' || (m[1] !== '100644' && m[1] !== '100755')) continue;
    if (pathAnomaly(m[4])) continue;
    entries.push({ mode: m[1], sha: m[3], path: m[4] });
  }
  const blobs = await readBlobs(root, entries.map((e) => e.sha));
  for (const e of entries) {
    const target = join(work, e.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, blobs.get(e.sha), { flag: 'wx', mode: e.mode === '100755' ? 0o755 : 0o644 });
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

// Findings carry a keyed hash (per-process random salt, never output) so a low-entropy
// subject cannot be recovered from the output by brute force.
const RUN_SALT = randomBytes(16);
function keyedHash(text) {
  return createHmac('sha256', RUN_SALT).update(String(text)).digest('hex').slice(0, 8);
}

function mk(ruleId, path, line = 0, subject = '') {
  const s = String(subject);
  return { ruleId, path, line, length: s.length, hash: keyedHash(`${ruleId}|${path}|${line}|${s}`) };
}

// ---------------------------------------------------------------------------
// Text normalization shared by every text scan (T-35, T-38, T-39)
// ---------------------------------------------------------------------------

// Zero-width, bidi, soft hyphen, variation selectors, tag characters, BOM and other format controls.
const INVISIBLE_RANGES = [
  [0xad], [0x34f], [0x61c], [0x115f], [0x1160], [0x17b4], [0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164], [0xfe00, 0xfe0f], [0xfeff],
  [0xffa0], [0xffd0, 0xffd2], [0xe0000, 0xe0fff], [0x1d173, 0x1d17a],
];
const INVISIBLE_RE = new RegExp(
  `[${INVISIBLE_RANGES.map(([a, b]) => (b === undefined ? fromCodes(a) : `${fromCodes(a)}-${fromCodes(b)}`)).join('')}]`,
  'gu',
);
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Invisible characters of a line, except an emoji ZWJ sequence joiner or a variation selector after a pictograph. */
export function invisibleChars(text) {
  const s = String(text);
  const out = [];
  for (const m of s.matchAll(INVISIBLE_RE)) {
    const ch = m[0];
    const before = s.slice(0, m.index).match(/(\p{Extended_Pictographic}|\p{Emoji_Modifier})\uFE0F?$/u);
    const after = /^\p{Extended_Pictographic}/u.test(s.slice(m.index + ch.length));
    if (ch === '\u200d' && before && after) continue;
    if (ch === '\ufe0f' && before) continue;
    out.push(ch);
  }
  return out;
}

export function normalizeText(text) {
  return String(text).normalize('NFKC').replace(INVISIBLE_RE, '').replace(CONTROL_RE, '');
}

const ENTITY_RE = /&#(?:x([0-9a-fA-F]{1,6})|(\d{1,7}));/g;
const UESC_RE = /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g;
const PCT_RE = /(?:%[0-9a-fA-F]{2}){2,}/g;
const B64_RE = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const cp = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd');

/**
 * Bounded decode views of a line: HTML numeric entities, percent-encoding, base64-looking runs,
 * and (optionally) backslash escapes. Each view is a full line with the decoding applied.
 */
export function decodeViews(text, { escapes = true } = {}) {
  const s = String(text);
  const views = [];
  if (s.length > 100000) return views;
  if (s.includes('&#')) views.push(s.replace(ENTITY_RE, (_, h, d) => cp(h ? parseInt(h, 16) : parseInt(d, 10))));
  if (escapes && s.includes('\\')) {
    views.push(s.replace(UESC_RE, (_, a, b, c) => cp(parseInt(a || b || c, 16))));
  }
  if (s.includes('%')) {
    views.push(s.replace(PCT_RE, (m) => { try { return decodeURIComponent(m); } catch { return m; } }));
  }
  let n = 0;
  for (const m of s.matchAll(B64_RE)) {
    if (++n > 50) break;
    for (const cut of [0, 1, 2]) {
      const raw = m[0].slice(cut).replace(/-/g, '+').replace(/_/g, '/');
      try {
        const buf = Buffer.from(raw, 'base64');
        const dec = decodeStrict(buf);
        if (dec !== undefined && dec.length >= 4) views.push(dec);
      } catch { /* not base64 */ }
    }
  }
  return views;
}

// ---------------------------------------------------------------------------
// Rule 2: path scope
// ---------------------------------------------------------------------------

// Scope findings after which the submitted tests are not run. A protected-file edit alone (for
// example lib/verdict.mjs) stays a plain reject: it carries no link and no unlisted path.
const SCOPE_NO_RUN = new Set(['G0-SCOPE-SPECIAL', 'G0-SCOPE-PATH']);
const FOLD = (p) => String(p).normalize('NFC').toLowerCase();

/** Path anomalies that make a name unsafe to match or print (T-12, T-16). */
export function pathAnomaly(path) {
  const p = String(path);
  if (p === '' || p.startsWith('/') || p.endsWith('/') || /^[A-Za-z]:/.test(p)) return true;
  if (p.includes('\\') || p.includes('\ufffd') || /[\u0000-\u001f\u007f-\u009f]/.test(p) || invisibleChars(p).length > 0) return true;
  if (/[\u2028\u2029]/.test(p)) return true;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return true;
    if (/^\.git(?:$|[./ ~])/i.test(seg) || /^git~\d/i.test(seg) || /[. ]$/.test(seg)) return true;
  }
  return false;
}

export function checkScope(files, issue) {
  const findings = [];
  const allow = issue.allowChanges || {};
  const seenFold = new Map();
  const check = (path, kind) => {
    if (pathAnomaly(path) || /[\u0000-\u001f]/.test(path)) { findings.push(mk('G0-SCOPE-PATH', path, 0, `anomaly:${kind}`)); return; }
    const f = FOLD(path);
    if (!matchesAny(path, issue.allowedPaths)) findings.push(mk('G0-SCOPE-PATH', path, 0, kind));
    for (const p of PROTECTED) {
      if ((p.test(path) || p.test(f)) && allow[p.flag] !== true) findings.push(mk('G0-SCOPE-PROTECTED', path, 0, p.flag));
    }
  };
  for (const f of files) {
    check(f.path, 'new');
    if (f.badPath) findings.push(mk('G0-SCOPE-PATH', f.path, 0, 'encoding'));
    if (f.status !== 'D') {
      const fold = FOLD(f.path);
      if (seenFold.has(fold) && seenFold.get(fold) !== f.path) findings.push(mk('G0-SCOPE-PATH', f.path, 0, 'collision'));
      seenFold.set(fold, f.path);
    }
    if ((f.status === 'R' || f.status === 'C') && f.oldPath !== f.path) check(f.oldPath, 'old');
    const modes = [f.oldMode, f.newMode];
    if (modes.includes('120000') && allow.symlinks !== true) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'symlink'));
    if (modes.includes('160000') && allow.submodules !== true) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'submodule'));
    if (f.binary && allow.binaries !== true) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'binary'));
    if (f.lfs === true) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'lfs'));
    // Modes: only regular files; an exec-bit flip or a type change needs the `modes` flag.
    const regular = (m) => m === '100644' || m === '100755' || m === '000000' || m === '' || m === '120000' || m === '160000';
    if (!regular(f.oldMode) || !regular(f.newMode)) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'mode'));
    else if (allow.modes !== true) {
      const flip = (f.oldMode === '100644' && f.newMode === '100755') || (f.oldMode === '100755' && f.newMode === '100644');
      const typeChange = f.status === 'T';
      if (flip || typeChange) findings.push(mk('G0-SCOPE-SPECIAL', f.path, 0, 'mode'));
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 3: frozen tokens
// ---------------------------------------------------------------------------

/** Blank out fenced code blocks and HTML comments (line structure is kept). */
export function maskNonProse(text) {
  const lines = String(text).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' ')).split('\n');
  let fence = null;
  return lines.map((l) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (m) {
      if (fence === null) { fence = m[1][0]; return ''; }
      if (m[1][0] === fence) { fence = null; return ''; }
    }
    return fence === null ? l : '';
  }).join('\n');
}

const squash = (t) => String(t).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
// English parentheticals after a frozen token are allowed to change: compare without them.
const unparen = (t) => squash(String(t).replace(/\s*\([^()\n]*\)/g, ''));
function verdictLinesOf(text, registry) {
  const out = [];
  let fence = false;
  for (const line of String(text).split('\n')) {
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) { fence = !fence; continue; }
    for (const m of line.matchAll(registry.verdictLine)) out.push(`${fence ? 'fence' : 'prose'}:${unparen(m[0])}`);
  }
  return out;
}
const multiset = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
function missingFrom(baseArr, headArr) {
  const h = multiset(headArr);
  const missing = [];
  for (const x of baseArr) { if (h.get(x) > 0) h.set(x, h.get(x) - 1); else missing.push(x); }
  return missing;
}

/** Lines made only of frozen tokens and separators (vocabulary lists), at least two tokens. */
function vocabLinesOf(text, registry) {
  const out = [];
  for (const raw of maskNonProse(text).split('\n')) {
    let rest = raw;
    let n = 0;
    for (const t of registry.tokens) {
      const re = tokenRegExp(t);
      rest = rest.replace(re, () => { n++; return ''; });
    }
    if (n >= 2 && /^[\s\p{P}\p{S}]*$/u.test(rest)) out.push(squash(raw));
  }
  return out;
}

// Well-known HTML tag names: a `<name>` made of one of these (first word, any case) is markup,
// not a placeholder, so the per-file placeholder rule never freezes it.
const HTML_TAGS = new Set([
  'a', 'abbr', 'audio', 'b', 'blockquote', 'br', 'caption', 'center', 'cite', 'code', 'dd', 'del', 'details',
  'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i',
  'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture', 'pre', 'q', 's', 'small', 'source', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'var', 'video',
]);
// A placeholder: angle brackets around a short phrase (at most four words, 40 characters) that
// starts and ends with a letter or digit, with no `=`, `/`, `@` or quote characters (so no
// attributes, closing tags, autolinks or addresses), not glued to a preceding word (generics).
const PLACEHOLDER_RE = /(?<![\p{L}\p{N}_])<([\p{L}\p{N}](?:[^<>=/@\n"'`]{0,38}[\p{L}\p{N}])?)>/gu;

/**
 * Placeholder matches of a text with their start offsets. In code files (CODE_FILE_RE) only
 * matches located entirely inside a string, template literal or comment count, found with the
 * same literal scanner as the test counter (stripNonCode blanks exactly those spans). A regex
 * literal (blanked between two slashes) is skipped too. Code outside literals (generics,
 * comparisons, shifts, arrows, JSX) is therefore never a placeholder; Markdown, text and data
 * files use every match.
 */
function placeholderMatches(path, text) {
  const all = [...String(text).matchAll(PLACEHOLDER_RE)];
  if (!CODE_FILE_RE.test(String(path))) return all;
  const code = stripNonCode(text);
  if (code.length !== String(text).length) return all; // cannot map offsets: freeze more, never less
  return all.filter((m) => {
    const a = m.index;
    const b = a + m[0].length;
    if (!/^ +$/.test(code.slice(a, b))) return false;
    let l = a - 1;
    while (l >= 0 && code[l] === ' ') l--;
    let r = b;
    while (r < code.length && code[r] === ' ') r++;
    return !(code[l] === '/' && code[r] === '/');
  });
}

/**
 * Placeholders of one file's BASE content (the per-file frozen set), Markdown, text, data and
 * code files alike (code files: only inside strings, template literals and comments).
 */
export function filePlaceholders(f) {
  const out = new Set();
  if (typeof f.baseContent !== 'string') return [];
  for (const m of placeholderMatches(f.path, f.baseContent)) {
    const words = m[1].trim().split(/\s+/);
    if (words.length > 4 || HTML_TAGS.has(words[0].toLowerCase())) continue;
    out.add(m[0]);
  }
  return [...out];
}

export function checkFrozenTokens(files, registry) {
  const findings = [];
  for (const f of files) {
    if (f.symlink || f.oldMode === '160000' || f.newMode === '160000') continue;
    // Binary blobs carry no decoded content (their strings are scanned elsewhere): nothing to compare.
    if (f.binary && f.baseContent === '' && f.headContent === '') continue;
    // Registry tokens plus every placeholder of this file's own base content: renaming or
    // dropping one (also in a file that is not a template) fails; the count may not go down.
    const known = new Set(registry.tokens);
    const perFile = filePlaceholders(f).filter((t) => !known.has(t));
    for (const token of [...registry.tokens, ...perFile]) {
      const before = countTokenForInvariant(f.baseContent, token);
      if (before === 0) continue;
      const after = countTokenForInvariant(f.headContent, token);
      if (after < before) findings.push(mk('G0-TOKEN', f.path, 0, token));
    }
    // The verdict line: every anchored base line, including fenced lines, must still
    // exist, as its own line, in the head version of the same file; a decoy elsewhere does not count.
    if (missingFrom(verdictLinesOf(f.baseContent, registry), verdictLinesOf(f.headContent, registry)).length > 0) {
      findings.push(mk('G0-VERDICT-LINE', f.path, 0, 'first-line'));
    }
    // Vocabulary lines (status words, continuation words) must survive as whole lines.
    if (missingFrom(vocabLinesOf(f.baseContent, registry), vocabLinesOf(f.headContent, registry)).length > 0) {
      findings.push(mk('G0-TOKEN-LINE', f.path, 0, 'vocabulary'));
    }
    // Near misses: an added line that carries the label but is not an anchored verdict line.
    for (const l of f.added) {
      if (l.text.includes(registry.verdictLabel) && verdictLinesOf(l.text, registry).length === 0) {
        findings.push(mk('G0-VERDICT-LINE', f.path, l.line, 'near-miss'));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 4: language direction (and invisible characters)
// ---------------------------------------------------------------------------

const CODE_FILE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const TEST_DIR_RE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]s$/;
const MAX_LINE = 65536;

function cjkResidue(view, tokens) {
  const residue = stripFrozenCjk(view, tokens);
  return countCjk(residue) > 0 ? residue : undefined;
}

/**
 * Views of one added line, all scanned for CJK: raw, normalized (NFKC, invisible characters
 * removed) and bounded decodes (entities, percent, base64, and backslash escapes in non-test
 * files; test fixtures write CJK as escapes by repository convention).
 */
function lineViews(text, path) {
  const norm = normalizeText(text);
  const views = [text];
  if (norm !== text) views.push(norm);
  const escapes = !TEST_DIR_RE.test(path);
  for (const v of decodeViews(norm, { escapes })) views.push(v, normalizeText(v));
  return views;
}

export function checkDirection(files, registry, cjkPathAllowlist = []) {
  const findings = [];
  for (const f of files) {
    if (f.oldMode === '160000' || f.newMode === '160000') continue;
    const allowlisted = matchesAny(f.path, cjkPathAllowlist);
    // Names are text too: a new path may not carry CJK (the allowlist is for content only).
    if (f.status !== 'D') {
      for (const view of [f.path, normalizeText(f.path), ...decodeViews(f.path, { escapes: false })]) {
        if (cjkResidue(view, registry.tokens) !== undefined) { findings.push(mk('G0-LANG-CJK', f.path, 0, 'path')); break; }
      }
    }
    const baseSet = new Set(f.removed.map((l) => squash(normalizeText(l.text))));
    // Frozen placeholders of this file (kept Chinese ones are not new CJK).
    const frozen = [...registry.tokens, ...filePlaceholders(f)];
    for (const l of f.added) {
      const inv = invisibleChars(l.text);
      if (inv.length > 0) findings.push(mk('G0-INVISIBLE', f.path, l.line, inv.join('')));
      if (l.text.length > MAX_LINE || (MARKDOWN_RE.test(f.path) && l.text.length > MAX_MD_LINE)) {
        findings.push(mk('G0-LIMIT', f.path, l.line, 'line'));
        continue;
      }
      let hit;
      for (const view of lineViews(l.text, f.path)) {
        hit = cjkResidue(view, frozen);
        if (hit !== undefined) break;
      }
      if (hit === undefined) continue;
      if (!allowlisted) findings.push(mk('G0-LANG-CJK', f.path, l.line, hit.match(CJK_RE).join('')));
      else if (!baseSet.has(squash(normalizeText(l.text)))) {
        // Allowlisted file: a CJK line is acceptable only when it is the same line moved
        // (removed and added), never a new one.
        findings.push(mk('G0-LANG-BALANCE-LINE', f.path, l.line, hit.match(CJK_RE).join('')));
      }
    }
    const added = f.added.reduce((s, l) => s + countCjk(normalizeText(l.text)), 0);
    const removed = f.removed.reduce((s, l) => s + countCjk(normalizeText(l.text)), 0);
    if (added > removed) findings.push(mk('G0-LANG-BALANCE', f.path, 0, `${added}>${removed}`));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rule 1 (static part): test counts and disable markers
// ---------------------------------------------------------------------------

export function checkTestIntegrity(files, issue) {
  const findings = [];
  const allow = issue.allowChanges || {};
  const stats = testStats(files);
  if (allow.tests !== true && (stats.headFiles < stats.baseFiles || stats.headCases < stats.baseCases)) {
    findings.push(mk('G0-TEST-COUNT', '<tests>', 0, JSON.stringify(stats)));
  }
  if (issue.allowSkip !== true) {
    // Every added line of every file is checked, not just recognized test files. The same
    // rules apply to newly added Markdown.
    for (const f of files) {
      if (f.status === 'D') continue;
      const md = MARKDOWN_RE.test(f.path);
      const code = !md;
      for (const l of f.added) {
        const texts = [l.text];
        const norm = normalizeText(l.text);
        if (norm !== l.text) texts.push(norm);
        const bad = texts.some((t) => SKIP_RE.test(t)
          || (code && BRACKET_SKIP_RE.test(t))
          || (code && TEST_DIR_RE.test(f.path) && DYNAMIC_EVAL_RE.test(t)));
        if (bad) findings.push(mk('G0-TEST-SKIP', f.path, l.line, l.text));
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Rules 5-6: hygiene
// ---------------------------------------------------------------------------

// Total characters (before the normalized copies) of added lines, binary strings and history
// lines handed to the hygiene scanner in one run. Nothing is truncated: above the cap the gate
// blocks (G0-LIMIT). Lines of any length are scanned whole (the scanner windows them itself).
const MAX_HYGIENE_CHARS = 64 * 1024 * 1024;

export function collectHygiene(files, metadata, denylist, baseline, deadline, history = [], maxChars = MAX_HYGIENE_CHARS) {
  const addedLines = [];
  const paths = [];
  let total = 0;
  const push = (path, l) => {
    const text = l.text;
    total += text.length;
    if (total > maxChars) throw new GateSignal('G0-LIMIT');
    addedLines.push({ path, line: l.line, text });
    const norm = normalizeText(text);
    if (norm !== text) addedLines.push({ path, line: l.line, text: norm });
  };
  for (const f of files) {
    if (f.status === 'A' || f.status === 'R' || f.status === 'C') paths.push(f.path);
    if ((f.status === 'R' || f.status === 'C') && f.oldPath) paths.push(f.oldPath);
    // Binary blobs are never skipped: their printable strings are in `added`.
    for (const l of f.added) push(f.path, l);
  }
  // Lines that exist only in an intermediate commit of the range.
  for (const h of history) push(h.path, h);
  return scanHygiene({ addedLines, paths, metadata, denylist, deadline, allowlist: { testFakes: baseline.testFakes || [] } });
}

const SAFE_PATH_RE = /^[A-Za-z0-9._/-]{1,120}$/;

/**
 * Print only paths in a safe character set that also pass the hygiene scan; everything else
 * becomes `<path:HASH8>` (keyed hash). When the denylist is unavailable (denylist === undefined)
 * nothing can be vetted, so every path (the fixed placeholders aside) becomes `<redacted:LEN:HASH8>`.
 */
function redactPaths(findings, denylist, vetted = new WeakSet()) {
  const cache = new Map();
  const show = (p) => {
    if (!cache.has(p)) {
      const s = String(p);
      if (denylist === undefined) {
        cache.set(p, `<redacted:${s.length}:${keyedHash(s)}>`);
      } else {
        const dirty = !SAFE_PATH_RE.test(s) || scanHygiene({ paths: [p], denylist }).length > 0;
        cache.set(p, dirty ? `<path:${keyedHash(s)}>` : s);
      }
    }
    return cache.get(p);
  };
  // Only placeholders Gate 0 itself generated are printed as is.
  const own = (f) => (f.path === '<tests>' && /^G0-TEST/.test(f.ruleId)) || (f.path === '<metadata>' && f.ruleId === 'G0-LANG-CJK');
  return findings.map((f) => {
    const safe = own(f) ? f.path : vetted.has(f) && (SAFE_PATH_RE.test(String(f.path)) || /^<(?:metadata|path|redacted)[:#A-Za-z0-9_ -]{0,60}>$/.test(String(f.path))) ? f.path : show(f.path);
    return { ...f, path: safe };
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

const ISSUE_KEYS = new Set(['allowedPaths', 'allowChanges', 'allowSkip']);
const ALLOW_FLAGS = new Set(['gate0', 'verdict', 'allowlists', 'packageJson', 'lockfiles', 'ci', 'scripts', 'gitconfig',
  'templates', 'nodeModules', 'symlinks', 'submodules', 'binaries', 'tests', 'modes', 'anyPath']);

/** Strict issue schema: known keys only, bounded sizes, supported glob syntax only (T-21, T-22). */
function validateIssue(issue) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) throw new GateSignal('G0-INPUT');
  for (const k of Object.keys(issue)) if (!ISSUE_KEYS.has(k)) throw new GateSignal('G0-INPUT');
  if (!validGlobList(issue.allowedPaths) || issue.allowedPaths.length > 200) throw new GateSignal('G0-INPUT');
  const ac = issue.allowChanges;
  if (ac !== undefined) {
    if (ac === null || typeof ac !== 'object' || Array.isArray(ac)) throw new GateSignal('G0-INPUT');
    for (const [k, v] of Object.entries(ac)) if (!ALLOW_FLAGS.has(k) || typeof v !== 'boolean') throw new GateSignal('G0-INPUT');
  }
  if (issue.allowSkip !== undefined && typeof issue.allowSkip !== 'boolean') throw new GateSignal('G0-INPUT');
  const anyPath = ac && ac.anyPath === true;
  for (const g of issue.allowedPaths) {
    if (g.length > 200 || /[[\]{}!\\\u0000-\u001f]/.test(g)) throw new GateSignal('G0-INPUT');
    if (!anyPath && /^(?:\*+|\*\*\/\*+)$/.test(normPath(g))) throw new GateSignal('G0-INPUT');
  }
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

const METADATA_STRINGS = ['prTitle', 'prBody', 'branch'];
const META_ENV_BAD = ['NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_REPL_EXTERNAL_MODULE'];

/** True when `inner` is inside `outer` (both resolved through realpath). */
async function isInside(inner, outer) {
  try {
    const a = await realpath(inner);
    const b = await realpath(outer);
    const rel = relative(b, a);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  } catch { return false; }
}

async function execute(opts, deadline) {
  validateIssue(opts.issue);
  const issue = opts.issue;
  const runnerTimeoutMs = opts.runnerTimeoutMs ?? DEFAULT_RUNNER_TIMEOUT_MS;
  if (!Number.isFinite(runnerTimeoutMs) || runnerTimeoutMs <= 0) throw new GateSignal('G0-INPUT');

  // Host run: Gate 0 must be a trusted copy outside the reviewed tree and must start from a
  // clean process environment (T-01..T-03). The code itself imports nothing from the tree.
  if (opts.hostRun === true) {
    if (META_ENV_BAD.some((k) => typeof process.env[k] === 'string' && process.env[k] !== '')) throw new GateSignal('G0-ENV');
    if (typeof opts.root === 'string' && await isInside(fileURLToPath(import.meta.url), opts.root)) throw new GateSignal('G0-SELF');
  }

  const ctx = opts.diff ? { ...normalizeDiff(opts.diff), gitMeta: undefined }
    : { ...(await collectGitDiff({ root: opts.root, baseRef: opts.baseRef })) };
  const { files } = ctx;
  const base = ctx.base || {};
  // Git mode: the baseline comes ONLY from the merge base; a caller-supplied `baseline` is
  // ignored, so a run can never widen CJK allowlists, test fakes or frozen tokens. An injected
  // baseline is honored only for a pre-parsed diff (unit fixtures).
  const baseline = validateBaseline(opts.diff && opts.baseline !== undefined ? opts.baseline : base.baseline);
  const templates = baseline.templates ?? base.templates ?? [];

  // Supplied metadata is additive: in git mode the real commit messages and identities are
  // always scanned, together with whatever the caller supplied.
  const metadata = { ...(opts.metadata || {}) };
  for (const key of ['commitMessages', 'authors']) {
    const supplied = metadata[key];
    if (supplied !== undefined && !(Array.isArray(supplied) && supplied.every((x) => typeof x === 'string'))) throw new GateSignal('G0-INPUT');
    if (ctx.gitMeta) metadata[key] = [...new Set([...ctx.gitMeta[key], ...(supplied || [])])];
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

  // Metadata fields must be strings when present; a host run requires all of them.
  {
    const m = opts.metadata || {};
    for (const k of METADATA_STRINGS) {
      if (m[k] !== undefined && typeof m[k] !== 'string') addBlock('G0-METADATA');
      if (opts.hostRun === true && typeof m[k] !== 'string') addBlock('G0-METADATA');
    }
    if (opts.hostRun === true && typeof m.branch === 'string' && m.branch === '') addBlock('G0-METADATA');
  }

  // Freeze the denylist BEFORE any submitted code runs (T-06).
  let denylist;
  try {
    // The reviewed repository root is passed on every call path, so the "denylist outside the
    // repository" check never depends on the process working directory (symlinks are resolved
    // by the loader's own trust check).
    let repoRoot;
    if (typeof opts.root === 'string' && opts.root) {
      try { repoRoot = await realpath(resolve(opts.root)); } catch { repoRoot = resolve(opts.root); }
    }
    denylist = loadDenylist({ env: opts.env || process.env, hostRun: opts.hostRun === true, fixture: opts.denylist, repoRoot });
  } catch (err) {
    addBlock(blockCodeOf(err));
  }

  // Rule 2, rule 1 (static)
  await step(() => checkScope(files, issue));
  await step(() => checkTestIntegrity(files, issue));
  // Rules 3 and 4 need the registry (derived from BASE text only)
  let registry;
  await step(() => {
    registry = buildRegistry({ verdictSource: base.verdictSource, templates, sharedPrompt: base.sharedPrompt, extras: baseline.frozenTokens });
    return [];
  });
  if (registry) {
    await step(() => checkFrozenTokens(files, registry));
    await step(() => checkDirection(files, registry, baseline.cjkPathAllowlist));
    // Metadata text must be English too (commit messages, PR text, branch).
    await step(() => {
      const texts = [...(metadata.commitMessages || []), ...METADATA_STRINGS.map((k) => (opts.metadata || {})[k]).filter((x) => typeof x === 'string')];
      const bad = texts.some((t) => [t, normalizeText(t), ...decodeViews(t, { escapes: false })].some((v) => cjkResidue(v, registry.tokens) !== undefined));
      return bad ? [mk('G0-LANG-CJK', '<metadata>', 0, 'metadata')] : [];
    });
  }
  // Rules 5-6 (before any submitted code runs)
  // scanHygiene already vets (or replaces) every path it reports: those findings are trusted.
  const vetted = new WeakSet();
  if (denylist) {
    await step(() => {
      const out = collectHygiene(files, metadata, denylist, baseline, deadline, ctx.gitMeta ? ctx.gitMeta.historyAdded : [], opts.maxHygieneChars);
      for (const f of out) vetted.add(f);
      return out;
    });
  }
  // Rule 1 (run base command). Submitted code is never run when the diff carries a symlink,
  // a submodule or a path outside the allowed scope: that is a block, not a test result.
  await step(async () => {
    if (blocks.length) return [];
    if (findings.some((f) => SCOPE_NO_RUN.has(f.ruleId))) throw new GateSignal('G0-TESTS-SKIPPED-SCOPE');
    if (opts.hostRun === true && opts.networkIsolated !== true) throw new GateSignal('G0-NETWORK');
    let basePackage;
    try { basePackage = JSON.parse(String(base.packageJson)); } catch { throw new GateSignal('G0-INPUT'); }
    const scripts = basePackage && typeof basePackage.scripts === 'object' && basePackage.scripts ? basePackage.scripts : {};
    if (typeof scripts.test !== 'string' || !scripts.test.trim()) throw new GateSignal('G0-INPUT');
    await verifyDepsDir({ depsDir: opts.depsDir, baseLockfile: base.lockfile, hasDeps: declaresDependencies(basePackage) });
    const runner = opts.runner || (opts.diff ? undefined : defaultRunner);
    if (typeof runner !== 'function') throw new GateSignal('G0-INPUT');
    const controller = new AbortController();
    const baseFiles = { 'package.json': String(base.packageJson) };
    const spec = {
      root: opts.root, baseRef: opts.baseRef, headSha: ctx.shas ? ctx.shas.head : undefined,
      command: scripts.test, scripts,
      basePackage, engines: basePackage.engines || {}, env: buildRunnerEnv(opts.env || process.env),
      timeoutMs: runnerTimeoutMs, signal: controller.signal, depsDir: opts.depsDir, baseLockfile: base.lockfile, baseFiles,
      networkIsolated: opts.networkIsolated === true,
    };
    const result = await withTimeout(() => Promise.resolve(runner(spec)), runnerTimeoutMs, controller);
    if (!result || typeof result !== 'object') throw new GateSignal('G0-RUNNER');
    if (result.timedOut === true) throw new GateSignal('G0-TIMEOUT');
    if (result.limit === true) throw new GateSignal('G0-LIMIT');
    if (!Number.isInteger(result.exitCode)) throw new GateSignal('G0-RUNNER');
    // Evidence of execution (T-25, T-26): a passing exit code with no executed tests, or with
    // skipped, pending or cancelled tests, is not a pass. Injected runners may omit counters.
    if (result.exitCode === 0 && result.counts && typeof result.counts === 'object') {
      if (result.expectTests === true) {
        const baseResult = await withTimeout(() => Promise.resolve(runner({ ...spec, headSha: ctx.shas?.base, compareBase: true })), runnerTimeoutMs, controller);
        if (!baseResult || baseResult.timedOut || baseResult.limit || baseResult.exitCode !== 0 || baseResult.expectTests !== true) throw new GateSignal('G0-RUNNER');
        if (!Number.isInteger(result.counts.tests) || !Number.isInteger(baseResult.counts?.tests)) throw new GateSignal('G0-RUNNER');
        if (result.counts.tests < baseResult.counts.tests) return [mk('G0-TEST-COUNT', '<tests>', 0, 'executed')];
      }
      const c = result.counts;
      if (result.expectTests === true && !(c.tests > 0)) throw new GateSignal('G0-TESTS-NONE');
      // A touched test file that had cases on the base but whose run executes no case at all.
      if (result.expectTests === true && c.subtests === 0 && testStats(files).baseCases > 0) throw new GateSignal('G0-TESTS-NONE');
      if (issue.allowSkip !== true && (c.skipped > 0 || c[PENDING_KEY] > 0 || c.cancelled > 0)) return [mk('G0-TEST-SKIP', '<tests>', 0, JSON.stringify(c))];
    }
    return result.exitCode === 0 ? [] : [mk('G0-TESTS', '<tests>', 0, String(result.exitCode))];
  });
  // The reviewed commit must still be the one that was checked (T-08).
  if (ctx.shas && !opts.diff) {
    try {
      if ((await resolveHead(opts.root)) !== ctx.shas.head) addBlock('G0-RACE');
    } catch (err) { addBlock(blockCodeOf(err)); }
  }

  let redacted;
  try { redacted = redactPaths(findings, denylist, vetted); } catch { addBlock('G0-INTERNAL'); redacted = []; }
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

/** Escape anything printable-unsafe in a field echoed to a log (control, bidi, non-ASCII), cap at 200. */
export function safeText(value) {
  let s = '';
  for (const ch of String(value).slice(0, 200)) {
    const c = ch.codePointAt(0);
    s += c >= 0x20 && c <= 0x7e ? ch : `\\u{${c.toString(16)}}`;
  }
  return s;
}

/** Human-readable, redacted rendering of a result. */
export function formatResult(result) {
  const lines = [`gate0: ${result.verdict}`];
  for (const b of result.blocks) lines.push(`BLOCK ${/^[A-Z0-9-]+$/.test(String(b.ruleId)) ? b.ruleId : 'G0-INTERNAL'}`);
  const safe = result.findings.slice(0, 200).map((f) => ({ ...f, path: safeText(f.path), ruleId: safeText(f.ruleId) }));
  const body = formatFindings(safe);
  if (body) lines.push(body.split('\n').map(safeText).join('\n'));
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
//
// Exit codes: 0 pass (no deterministic objection), 1 reject (findings), 2 block (anything that
// is not a verdict: bad input, crash, timeout, missing prerequisite). A crash is never exit 1.
// Output is one JSON line on stdout; stderr stays silent (rule IDs only in the JSON).
// Gate 0 must be run from a trusted copy outside the reviewed tree (host run: G0-SELF otherwise).
// ---------------------------------------------------------------------------

const MAX_INPUT_FILE = 1024 * 1024;

async function readJson(path) {
  const st = await lstat(path);
  if (!st.isFile() || st.size > MAX_INPUT_FILE) throw new GateSignal('G0-INPUT');
  const data = JSON.parse(await readFile(path, 'utf8'));
  if (data === null || typeof data !== 'object') throw new GateSignal('G0-INPUT');
  return data;
}

export async function main(argv = process.argv.slice(2)) {
  const opts = {};
  let issuePath;
  let metaPath;
  let explicitHost = false;
  let local = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--root') opts.root = argv[++i];
      else if (a === '--base') opts.baseRef = argv[++i];
      else if (a === '--issue') issuePath = argv[++i];
      else if (a === '--metadata') metaPath = argv[++i];
      else if (a === '--host-run') explicitHost = true;
      else if (a === '--local' || a === '--no-host-run') local = true;
      else if (a === '--network-isolated') opts.networkIsolated = true;
      else if (a === '--deps-dir') opts.depsDir = argv[++i];
      else if (a === '--timeout-ms') opts.timeoutMs = Number(argv[++i]);
      else throw new GateSignal('G0-INPUT');
    }
    if (!issuePath || (explicitHost && local)) throw new GateSignal('G0-INPUT');
    // Production (host-run) semantics are the default; --local is the explicit opt-out.
    opts.hostRun = !local;
    // Trusted inputs must live outside the reviewed tree (T-05).
    if (opts.hostRun && typeof opts.root === 'string') {
      for (const p of [issuePath, metaPath, opts.depsDir]) if (p && await isInside(p, opts.root)) throw new GateSignal('G0-INPUT');
    }
    opts.issue = await readJson(issuePath);
    if (metaPath) opts.metadata = await readJson(metaPath);
  } catch {
    process.stdout.write(`${JSON.stringify(blockResult('G0-INPUT'))}\n`);
    return 2;
  }
  const result = await runGate0(opts);
  // A local run is never authoritative: it may have run tests with network and no denylist.
  const shown = local ? { ...result, mode: 'local', authoritative: false } : result;
  process.stdout.write(`${JSON.stringify(shown)}\n`);
  return result.verdict === 'pass' ? 0 : result.verdict === 'reject' ? 1 : 2;
}

function crash() {
  try { process.stdout.write(`${JSON.stringify(blockResult('G0-INTERNAL'))}\n`); } catch { /* nothing left to do */ }
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
  main().then((code) => { process.exitCode = code; }, crash);
}
