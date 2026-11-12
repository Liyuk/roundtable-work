// Gate 0 host/secret hygiene checks.
//
// Deterministic, zero dependencies, no network, no model. This module can only
// report findings; it never writes anything and never echoes matched text.
//
// Findings have exactly these fields: { ruleId, path, line, length, hash }.
//   - `length` is the length of the matched text, `hash` is the first 8 hex
//     characters of its sha256. The matched text itself is never returned.
//   - A path that itself triggers a finding is reported as `<path:HASH8>` so a
//     leaking path name is not echoed either.
//   - Metadata is reported as `<metadata:commit#N>`, `<metadata:author#N>`,
//     `<metadata:prTitle>`, `<metadata:prBody>`, `<metadata:branch>` (N is
//     1-based). Multi-line fields (commit messages, PR body) use real 1-based
//     line numbers; single-valued fields and added paths use line 0.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const RULES = Object.freeze({
  IP: 'HYG-IP',
  HOST: 'HYG-HOST',
  USER: 'HYG-USER',
  FQDN: 'HYG-FQDN',
  HOMEPATH: 'HYG-HOMEPATH',
  CRED: 'HYG-CRED',
  ENC: 'HYG-ENC',
});

/** Hosts that are always acceptable (documentation, reserved and public code hosts). */
export const ALWAYS_ALLOWED_HOSTS = Object.freeze([
  'example.com', 'example.org', 'example.net', 'localhost',
  'github.com', 'githubusercontent.com', 'githubassets.com', 'gitlab.com',
  'npmjs.org', 'npmjs.com', 'registry.npmjs.org', 'nodejs.org', 'yarnpkg.com',
  'pypi.org', 'crates.io', 'rubygems.org', 'pkg.go.dev', 'mozilla.org',
]);

const PRIVATE_SUFFIXES = ['local', 'lan', 'internal', 'home'];
const MAX_DEPTH = 3;

function checkDeadline(deadline) {
  if (deadline !== undefined && Date.now() > deadline) throw new HygieneError('TIMEOUT', 'gate0: hygiene scan timed out');
}

export class HygieneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HygieneError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

const NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

function normalizeNames(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new HygieneError('DENYLIST_INVALID', 'gate0: denylist is invalid');
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string' || !NAME_OK.test(item.trim())) {
      throw new HygieneError('DENYLIST_INVALID', 'gate0: denylist is invalid');
    }
    out.push(item.trim().toLowerCase());
  }
  return [...new Set(out)];
}

function normalizeDenylist(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HygieneError('DENYLIST_INVALID', 'gate0: denylist is invalid');
  }
  const group = (g) => {
    if (g === undefined) return { distinctive: [], common: [] };
    if (g === null || typeof g !== 'object' || Array.isArray(g)) {
      throw new HygieneError('DENYLIST_INVALID', 'gate0: denylist is invalid');
    }
    return { distinctive: normalizeNames(g.distinctive), common: normalizeNames(g.common) };
  };
  return { hostnames: group(raw.hostnames), usernames: group(raw.usernames) };
}

function denylistIsEmpty(d) {
  return d.hostnames.distinctive.length + d.hostnames.common.length
    + d.usernames.distinctive.length + d.usernames.common.length === 0;
}

/**
 * Load the hostname/username denylist.
 * Production file: $RT_HOME/gate0/denylist.json (outside the repository).
 * Error messages are fixed strings: they never contain paths, file content or
 * parser output.
 */
export function loadDenylist({ env = process.env, hostRun = false, fixture } = {}) {
  let result;
  if (fixture !== undefined) {
    result = normalizeDenylist(fixture);
  } else {
    const home = env && typeof env.RT_HOME === 'string' ? env.RT_HOME : '';
    if (!home) {
      if (hostRun) throw new HygieneError('DENYLIST_MISSING', 'gate0: denylist unavailable on a host run');
      return { hostnames: { distinctive: [], common: [] }, usernames: { distinctive: [], common: [] } };
    }
    let text;
    try {
      text = readFileSync(join(home, 'gate0', 'denylist.json'), 'utf8');
    } catch (err) {
      if (hostRun) throw new HygieneError('DENYLIST_MISSING', 'gate0: denylist unavailable on a host run');
      if (err && err.code === 'ENOENT') {
        return { hostnames: { distinctive: [], common: [] }, usernames: { distinctive: [], common: [] } };
      }
      throw new HygieneError('DENYLIST_UNREADABLE', 'gate0: denylist unreadable');
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HygieneError('DENYLIST_INVALID', 'gate0: denylist is invalid');
    }
    result = normalizeDenylist(parsed);
  }
  if (hostRun && denylistIsEmpty(result)) {
    throw new HygieneError('DENYLIST_EMPTY', 'gate0: denylist is empty on a host run');
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shannon(s) {
  if (!s.length) return 0;
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const TEST_DIRS = new Set(['test', 'tests', '__tests__']);
const DOC_EXT_RE = /\.(?:md|markdown|mdx|txt|rst|adoc)$/i;

/**
 * True for test-fixture paths: under a `test/`, `tests/` or `__tests__/` directory, or
 * named `*.test.*` / `*.spec.*`. Documentation files are never fixtures.
 */
export function isTestFixturePath(path) {
  if (typeof path !== 'string' || path === '') return false;
  const segments = path.split(/[\\/]/);
  if (segments.includes('..')) return false;
  const file = segments[segments.length - 1];
  if (DOC_EXT_RE.test(file)) return false;
  if (segments.slice(0, -1).some((d) => TEST_DIRS.has(d))) return true;
  return /^[^.].*\.(?:test|spec)\.[A-Za-z0-9]+$/.test(file);
}

function hasFakeMarker(s) {
  return s.includes('EXAMPLE') || s.includes('FAKE');
}

function isPlaceholder(x) {
  // <user>, $USER, ${USER}, %USER%, and glob-like stars carry no identity.
  return /^<[^<>\s]*>$/.test(x) || /^\$/.test(x) || /^%[^%]*%$/.test(x) || x === '*' || x.startsWith('{');
}

export function isAllowedHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.test') || h.endsWith('.invalid')) return true;
  return ALWAYS_ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

// ---------------------------------------------------------------------------
// IP rules
// ---------------------------------------------------------------------------

function ipv4Allowed(o) {
  const [a, b, c] = o;
  if (a === 127) return true; // loopback
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (o.every((x) => x === 0)) return true; // unspecified
  // A contiguous netmask (all-ones prefix, then zeros) is not an address.
  const bits = o.map((x) => x.toString(2).padStart(8, '0')).join('');
  if (/^1+0*$/.test(bits)) return true;
  return false;
}

const HOST_CONTEXT_RE = /\b(?:git|clone|remote|origin|ssh|scp|sftp|rsync|mosh|telnet|ftp|rdp|vnc)\b|:\/\//i;
const PACKAGE_CONTEXT_RE = /\b(?:npm|npx|yarn|pnpm|pip|pip3|gem|cargo|install|package|packages|dependency|dependencies|version|versions|upgrade|requires?|depends?)\b/i;

// `name@<four-part version>` is exempt only in a package-version context: the name looks like a
// package, a package-manager word is on the line, no git/ssh/URL host context is, and
// the match is not followed by a path separator or a port. Everything else
// (`git@<ip>:org/repo`, `deploy@<ip>`, `https://user@<ip>/x`) is a host address.
// A `v` prefix (or `name@` package context) also covers a pre-release suffix.
function isPackageVersion(text, index, end, line) {
  const at = index - 1; // the '@'
  let i = at;
  while (i > 0 && at - i < 128 && /[A-Za-z0-9._\/-]/.test(text[i - 1])) i--;
  if (i > 0 && text[i - 1] === '@' && text.slice(i, at).includes('/')) i--; // @scope/name
  const name = text.slice(i, at);
  const before = i > 0 ? text[i - 1] : '';
  if (before !== '' && !/[\s"'`,(\[]/.test(before)) return false;
  if (name.length === 0 || !/^@?[a-z0-9][a-z0-9._\/-]*$/.test(name)) return false;
  const next = text[end] || '';
  if (next === ':' || next === '/') return false;
  if (line.host === undefined) {
    line.host = HOST_CONTEXT_RE.test(line.text);
    line.pkg = PACKAGE_CONTEXT_RE.test(line.text);
  }
  return !line.host && line.pkg;
}

function findIPv4(text, out) {
  const line = { text };
  const re = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d)/g;
  for (const m of text.matchAll(re)) {
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    if (octets.some((x) => x > 255)) continue;
    const end = m.index + m[0].length;
    if (text[end] === '.' && /\d/.test(text[end + 1] || '')) continue; // five-part version-like string
    const prev = m.index > 0 ? text[m.index - 1] : '';
    if (prev === 'v' || prev === 'V') {
      const before = m.index > 1 ? text[m.index - 2] : '';
      if (!/[A-Za-z0-9_]/.test(before)) continue; // v-prefixed four-part version
    }
    if (prev === '@' && isPackageVersion(text, m.index, end, line)) continue;
    if (ipv4Allowed(octets)) continue;
    out.push({ ruleId: RULES.IP, text: m[0] });
  }
}

function parseIPv6(s) {
  if (!/^[0-9A-Fa-f:]+$/.test(s)) return null;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const all = [...head, ...tail];
  if (all.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return null;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map((g) => parseInt(g, 16));
  }
  if (all.length > 7) return null;
  const zeros = new Array(8 - all.length).fill(0);
  return [...head, ...zeros.map(String), ...tail].map((g) => (typeof g === 'number' ? g : parseInt(g, 16)));
}

function ipv6Allowed(g) {
  if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  return false;
}

function findIPv6(text, out) {
  const re = /(?<![A-Za-z0-9_:.\-])[0-9A-Fa-f:]{2,}(?![A-Za-z0-9_:])(?!\.\d)/g;
  for (const m of text.matchAll(re)) {
    const s = m[0];
    if (!/\d/.test(s)) continue;
    if (!s.includes('::') && (s.match(/:/g) || []).length !== 7) continue;
    const groups = parseIPv6(s);
    if (!groups) continue;
    if (ipv6Allowed(groups)) continue;
    out.push({ ruleId: RULES.IP, text: s });
  }
}

// ---------------------------------------------------------------------------
// Denylisted names
// ---------------------------------------------------------------------------

const matcherCache = new WeakMap();

function buildNameMatchers(denylist) {
  if (matcherCache.has(denylist)) return matcherCache.get(denylist);
  const list = [];
  const add = (kind, rule) => {
    for (const name of kind.distinctive) {
      list.push({ ruleId: rule, re: new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`, 'gi') });
    }
    for (const name of kind.common) {
      const n = escapeRe(name);
      const suffixes = PRIVATE_SUFFIXES.join('|');
      const contexts = [
        // user@NAME
        `(?<![A-Za-z0-9_.+-])[A-Za-z0-9_.+-]+@${n}(?![A-Za-z0-9_-])`, // lookbehind keeps this linear
        // NAME@host (not an example/test/invalid mail domain)
        `(?<![A-Za-z0-9_.+-])${n}@(?!example\\.(?:com|org|net)\\b)(?![A-Za-z0-9.-]*\\.(?:test|invalid)\\b)[A-Za-z0-9_.-]+`,
        // ssh / scp / sftp / rsync command forms: NAME is one of the first arguments
        `\\b(?:ssh|scp|sftp|rsync)\\s+(?:\\S+\\s+){0,5}?(?:[A-Za-z0-9_.+-]+@)?${n}(?=[\\s:'"\`]|$)`,
        // URL authority
        `:\\/\\/(?:[^\\s\\/@]*@)?${n}(?![A-Za-z0-9_-])`,
        // NAME plus a private suffix
        `(?<![A-Za-z0-9_-])${n}\\.(?:${suffixes})(?![A-Za-z0-9_-])`,
      ];
      for (const c of contexts) list.push({ ruleId: rule, re: new RegExp(c, 'gi') });
    }
  };
  add(denylist.hostnames, RULES.HOST);
  add(denylist.usernames, RULES.USER);
  matcherCache.set(denylist, list);
  return list;
}

function findNames(text, denylist, out) {
  for (const { ruleId, re } of buildNameMatchers(denylist)) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) out.push({ ruleId, text: m[0] });
  }
}

// ---------------------------------------------------------------------------
// Private-suffix FQDNs
// ---------------------------------------------------------------------------

// Heuristic: a JS member access whose last property reads like a private suffix (an
// environment lookup of the home variable, a local flag on the current object, a home
// field on a user object) is not a host. The exemption applies ONLY to added lines in code files (see
// CODE_EXT_RE); it never applies to prose files (markdown, text, ...), other files,
// commit messages, PR title/body, branch names, authors or paths, where such a word
// with a private suffix is a private-suffix host name. In a code file a match is
// skipped when every label left of the private suffix
// is a common member-access root word (case-insensitive) AND it is not in a host
// position: after `://` or `@`, or on the argument side of a remote-shell / copy /
// network command (ssh, scp, rsync, sftp, mosh and similar), including a bare word
// standing alone as an argument to one. Real hosts (a box name or a service name with
// a private suffix) have other first labels and stay flagged; a host literally named
// like one of these words is only exempt in ordinary (non-host) code.
const MEMBER_ROOTS = new Set([
  'process', 'env', 'this', 'self', 'user', 'users', 'os', 'config', 'cfg', 'conf', 'settings',
  'options', 'opts', 'ctx', 'context', 'app', 'args', 'props', 'state', 'req', 'res', 'obj',
  'data', 'window', 'document', 'global', 'globalthis', 'module', 'exports', 'paths', 'dirs',
  'path', 'profile', 'account', 'session', 'info', 'result', 'item', 'entry',
]);

const REMOTE_COMMAND_RE = /(?<![A-Za-z0-9_.-])(?:ssh|scp|rsync|sftp|mosh|telnet|ftp|ping|curl|wget|nc)(?![A-Za-z0-9_-])/i;

function inRemoteCommandContext(text, index) {
  // Only the current command segment counts (a `;`, `&` or `|` starts a new one).
  const segment = text.slice(0, index).split(/[;&|]/).pop();
  return REMOTE_COMMAND_RE.test(segment);
}

const CODE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|json|jsonc|json5|vue|svelte|py|rb|go|rs|java|kt|cs|php|c|h|cc|cpp|hpp)$/i;

/** True for source-code paths where a JS-style member access can legitimately appear. */
function isCodePath(path) {
  if (typeof path !== 'string' || path === '') return false;
  const file = path.split(/[\\/]/).pop();
  return CODE_EXT_RE.test(file) && !DOC_EXT_RE.test(file);
}

// Heuristic: the match sits inside a string or template literal when the line has an odd
// number of unescaped quote characters of one kind before it, or the character right
// before the match is a quote.
function inStringLiteral(text, index) {
  if (index > 0 && /['"`]/.test(text[index - 1])) return true;
  const counts = { "'": 0, '"': 0, '`': 0 };
  for (let i = 0; i < index; i++) {
    const c = text[i];
    if (c === '\\') { i++; continue; }
    if (c in counts) counts[c]++;
  }
  return Object.values(counts).some((n) => n % 2 === 1);
}

function isMemberAccess(text, index, match) {
  if (inStringLiteral(text, index)) return false;
  const labels = match.split('.');
  labels.pop();
  if (!labels.every((l) => MEMBER_ROOTS.has(l.toLowerCase()))) return false;
  const p1 = index > 0 ? text[index - 1] : '';
  const p2 = index > 1 ? text[index - 2] : '';
  if (p1 === '@' || (p1 === '/' && p2 === '/')) return false;
  if (inRemoteCommandContext(text, index)) return false;
  return true;
}

function findFqdn(text, out, codeFile) {
  const suffixes = PRIVATE_SUFFIXES.join('|');
  const re = new RegExp(
    `(?<![A-Za-z0-9_.\\-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+(?:${suffixes})(?!\\.?[A-Za-z0-9_-])`,
    'gi',
  );
  for (const m of text.matchAll(re)) {
    // A path component such as src/config.local is not a host name.
    if (m.index > 0 && text[m.index - 1] === '/' && !(m.index > 1 && (text[m.index - 2] === '/' || text[m.index - 2] === ':'))) continue;
    if (codeFile && isMemberAccess(text, m.index, m[0])) continue;
    if (isAllowedHost(m[0])) continue;
    out.push({ ruleId: RULES.FQDN, text: m[0] });
  }
}

// ---------------------------------------------------------------------------
// Home paths
// ---------------------------------------------------------------------------

// A branch name cannot start with a slash, so a home path shows up as segments.
function findHomePathSegments(text, out) {
  const re = /(?:^|\/)(?:home|Users)\/(<[^>\s]*>|[A-Za-z0-9_.-]+)/gi;
  for (const m of text.matchAll(re)) {
    if (isPlaceholder(m[1])) continue;
    out.push({ ruleId: RULES.HOMEPATH, text: m[0].replace(/^\//, '') });
  }
}

function findHomePaths(text, out) {
  const X = '(<[^>\\s]*>|[^\\s\\/\\\\\'"`<>()\\[\\]{},;:*|]+)';
  const unixish = [
    new RegExp(`(?<![A-Za-z0-9_.\\-~$])\\/home\\/${X}`, 'g'),
    new RegExp(`(?<![A-Za-z0-9_.\\-~$])\\/Users\\/${X}`, 'g'),
  ];
  for (const re of unixish) {
    for (const m of text.matchAll(re)) {
      if (isPlaceholder(m[1])) continue;
      out.push({ ruleId: RULES.HOMEPATH, text: m[0] });
    }
  }
  for (const m of text.matchAll(/(?<![A-Za-z0-9_.\-~$])\/root\//g)) {
    out.push({ ruleId: RULES.HOMEPATH, text: m[0] });
  }
  const win = new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\\\/]{1,4}Users[\\\\\\/]{1,4}${X}`, 'gi');
  for (const m of text.matchAll(win)) {
    if (isPlaceholder(m[1])) continue;
    out.push({ ruleId: RULES.HOMEPATH, text: m[0] });
  }
  const tilde = /(?<![A-Za-z0-9_.\-~$\/])~(<[^>\s]*>|[A-Za-z_][A-Za-z0-9_.-]*)\//g;
  for (const m of text.matchAll(tilde)) {
    if (isPlaceholder(m[1])) continue;
    out.push({ ruleId: RULES.HOMEPATH, text: m[0] });
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

const TOKEN_PATTERNS = [
  /(?<![A-Za-z0-9_-])gh[pousr]_[A-Za-z0-9]{16,}/g,
  new RegExp('(?<![A-Za-z0-9_-])' + 'github' + '_pat_[A-Za-z0-9_]{20,}', 'g'),
  /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{16,}/g,
  new RegExp('(?<![A-Za-z0-9_-])(?:' + ['AK', 'AS'].map((x) => x + 'IA').join('|') + ')[0-9A-Z]{16}(?![A-Za-z0-9])', 'g'),
  /(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9_-])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // The header is assembled from pieces so this file holds no key-header literal.
  new RegExp('-'.repeat(5) + 'BEGIN [A-Z0-9 ]*PRIV' + 'ATE KEY(?: BLOCK)?' + '-'.repeat(5), 'g'),
];

// sk- style keys need a digit and a letter, so ordinary hyphenated words pass.
const SK_PATTERN = /(?<![A-Za-z0-9_-])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g;

const CRED_URL = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s\/:@'"<>]+:([^\s\/@'"<>]+)@[^\s\/'"<>]+/gi;

// The leading `(?:word[_.-])*` prefix is not needed (the lookbehind accepts a keyword
// after any separator) and made the scan quadratic; the suffix repetition is bounded.
const CRED_ASSIGN = /(?<![A-Za-z0-9])(?:token|secret|password|passwd|api[_-]?key)(?:[_.-][A-Za-z0-9]{1,40}){0,6}["']?\s*[:=]>?\s*["']?([^\s"'`,;]+)/gi;

// High-entropy heuristic for a credential assignment value (length >= 16):
//  - letters and digits mixed: Shannon entropy >= 3.25;
//  - letters only (no digit): needs mixed case and Shannon entropy >= 3.5, and must
//    not look like an identifier. A camelCase / PascalCase identifier is split into
//    words; ordinary words average 3+ letters per word, a random mixed-case string
//    averages about 2. Such identifier-like values are treated as references.
// Reference-looking values (containing `.`, `(`, `$`, `{`, or a `process.env.X` style
// reference) are never letters-only, so they cannot reach the letters-only branch
// (the digit branch is unchanged); a long all-lowercase word has no mixed case and a repeated value has low
// entropy, so neither triggers.
function looksLikeIdentifier(v) {
  const words = v.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [];
  return words.length > 0 && v.length / words.length >= 3;
}

function highEntropy(v) {
  if (v.length < 16) return false;
  if (/^[A-Za-z]+$/.test(v)) {
    if (!/[a-z]/.test(v) || !/[A-Z]/.test(v)) return false;
    if (looksLikeIdentifier(v)) return false;
    return shannon(v) >= 3.5;
  }
  if (!/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
  return shannon(v) >= 3.25;
}

function findCredentials(text, out, allowFake) {
  const push = (exemptOn, shown) => {
    if (allowFake && hasFakeMarker(exemptOn)) return;
    out.push({ ruleId: RULES.CRED, text: shown });
  };
  for (const re of TOKEN_PATTERNS) {
    for (const m of text.matchAll(re)) push(m[0], m[0]);
  }
  for (const m of text.matchAll(SK_PATTERN)) {
    if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0].slice(3))) push(m[0], m[0]);
  }
  for (const m of text.matchAll(CRED_URL)) {
    if (isPlaceholder(m[1])) continue;
    push(m[1], m[0]);
  }
  for (const m of text.matchAll(CRED_ASSIGN)) {
    const v = m[1];
    if (isPlaceholder(v) || /[(<]/.test(v)) continue;
    if (!highEntropy(v)) continue;
    push(v, v);
  }
}

// ---------------------------------------------------------------------------
// Decoded blobs
// ---------------------------------------------------------------------------

function printableRatio(buf) {
  if (buf.length === 0) return 0;
  let ok = 0;
  for (const b of buf) if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) ok++;
  return ok / buf.length;
}

function decodePercent(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    // Invalid UTF-8 sequence: decode byte by byte so one bad escape does not hide the rest.
    return s.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

function base64Candidates(text) {
  const cands = new Set();
  for (const m of text.matchAll(/[A-Za-z0-9+\/_-]{10,}={0,2}/g)) {
    cands.add(m[0]);
    for (const piece of m[0].split(/[\/_-]/)) if (piece.length >= 10) cands.add(piece);
  }
  return cands;
}

function findEncoded(text, denylist, depth, out, deadline, opts) {
  if (depth >= MAX_DEPTH) return;
  const decodedViews = [];
  // Linear: split into non-space tokens, then test each one (a `\S*%..\S*` pattern is quadratic).
  for (const m of text.matchAll(/\S+/g)) {
    if (m[0].includes('%') && /%[0-9A-Fa-f]{2}/.test(m[0])) {
      decodedViews.push({ source: m[0], decoded: decodePercent(m[0]) });
    }
  }
  for (const cand of base64Candidates(text)) {
    const buf = Buffer.from(cand.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length < 6 || printableRatio(buf) < 0.95) continue;
    decodedViews.push({ source: cand, decoded: buf.toString('latin1') });
  }
  for (const { source, decoded } of decodedViews) {
    if (decoded === source) continue;
    checkDeadline(deadline);
    if (scanText(decoded, denylist, depth + 1, deadline, opts).length > 0) {
      out.push({ ruleId: RULES.ENC, text: source });
    }
  }
}

// ---------------------------------------------------------------------------
// Text scanner
// ---------------------------------------------------------------------------

// `opts.allowFake` lets EXAMPLE / FAKE marked credentials pass. It is set only for
// added lines in test-fixture paths; metadata, path names and other files never get it.
// `opts.codeFile` enables the member-access FQDN exemption; it is set only for added
// lines in code files, never for metadata, path names or prose files.
function scanText(text, denylist, depth = 0, deadline, opts = {}) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  // The deadline is checked between detectors (a running regex cannot be interrupted,
  // so every detector is linear; see the long-line tests).
  const steps = [
    () => findIPv4(text, out),
    () => findIPv6(text, out),
    () => findNames(text, denylist, out),
    () => findFqdn(text, out, opts.codeFile === true),
    () => findHomePaths(text, out),
    () => findCredentials(text, out, opts.allowFake === true),
    () => findEncoded(text, denylist, depth, out, deadline, opts),
  ];
  for (const run of steps) {
    checkDeadline(deadline);
    run();
  }
  checkDeadline(deadline);
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function assertDenylist(d) {
  if (!d || typeof d !== 'object' || !d.hostnames || !d.usernames
    || !Array.isArray(d.hostnames.distinctive) || !Array.isArray(d.hostnames.common)
    || !Array.isArray(d.usernames.distinctive) || !Array.isArray(d.usernames.common)) {
    throw new HygieneError('DENYLIST_REQUIRED', 'gate0: denylist required');
  }
}

function normalizeAllowlist(allowlist) {
  if (allowlist === null || typeof allowlist !== 'object') {
    throw new HygieneError('ALLOWLIST_INVALID', 'gate0: allowlist is invalid');
  }
  const fakes = allowlist.testFakes === undefined ? [] : allowlist.testFakes;
  if (!Array.isArray(fakes)) throw new HygieneError('ALLOWLIST_INVALID', 'gate0: allowlist is invalid');
  const set = new Set();
  for (const f of fakes) {
    if (!f || typeof f.path !== 'string' || typeof f.hash !== 'string') {
      throw new HygieneError('ALLOWLIST_INVALID', 'gate0: allowlist is invalid');
    }
    set.add(`${f.path}\u0000${f.hash}`);
  }
  return set;
}

/**
 * Scan added lines, added/renamed paths and PR/commit metadata.
 * Returns findings: [{ ruleId, path, line, length, hash}] with no matched text.
 * There is deliberately no inline suppression mechanism; only the base-side
 * `allowlist.testFakes` (path + hash) can exempt a diff location.
 */
export function scanHygiene({ addedLines = [], paths = [], metadata = {}, denylist, allowlist = {}, deadline } = {}) {
  assertDenylist(denylist);
  const fakes = normalizeAllowlist(allowlist);
  const findings = [];
  const seen = new Set();
  const dirtyPathCache = new Map();

  const shownPath = (raw) => {
    if (!dirtyPathCache.has(raw)) {
      dirtyPathCache.set(raw, scanText(raw, denylist, 0, deadline).length > 0 ? `<path:${hashText(raw)}>` : raw);
    }
    return dirtyPathCache.get(raw);
  };

  const record = (rawPath, display, line, matches, allowFakes) => {
    for (const m of matches) {
      const hash = hashText(m.text);
      if (allowFakes && fakes.has(`${rawPath}\u0000${hash}`)) continue;
      const key = `${m.ruleId}|${display}|${line}|${hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ ruleId: m.ruleId, path: display, line, length: m.text.length, hash });
    }
  };

  for (const entry of Array.isArray(addedLines) ? addedLines : []) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.text !== 'string') {
      throw new HygieneError('INPUT_INVALID', 'gate0: addedLines entry is invalid');
    }
    const line = Number.isInteger(entry.line) ? entry.line : 0;
    const opts = { allowFake: isTestFixturePath(entry.path), codeFile: isCodePath(entry.path) };
    record(entry.path, shownPath(entry.path), line, scanText(entry.text, denylist, 0, deadline, opts), true);
  }

  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string') throw new HygieneError('INPUT_INVALID', 'gate0: path entry is invalid');
    const matches = scanText(p, denylist, 0, deadline);
    if (matches.length) record(p, `<path:${hashText(p)}>`, 0, matches, false);
  }

  const meta = metadata || {};
  const scanMulti = (label, text) => {
    if (typeof text !== 'string') return;
    text.split(/\r?\n/).forEach((l, i) => record(label, label, i + 1, scanText(l, denylist, 0, deadline), false));
  };
  const scanSingle = (label, text, relaxedHome = false) => {
    if (typeof text !== 'string') return;
    const matches = scanText(text, denylist, 0, deadline);
    if (relaxedHome) findHomePathSegments(text, matches);
    record(label, label, 0, matches, false);
  };
  (Array.isArray(meta.commitMessages) ? meta.commitMessages : []).forEach((t, i) => scanMulti(`<metadata:commit#${i + 1}>`, t));
  (Array.isArray(meta.authors) ? meta.authors : []).forEach((t, i) => scanSingle(`<metadata:author#${i + 1}>`, t));
  scanSingle('<metadata:prTitle>', meta.prTitle);
  scanMulti('<metadata:prBody>', meta.prBody);
  scanSingle('<metadata:branch>', meta.branch, true);

  return findings;
}

/** Render findings as text using only ruleId / path / line / length / hash. */
export function formatFindings(findings) {
  if (!Array.isArray(findings)) return '';
  return findings.map((f) => {
    const rule = /^[A-Z0-9-]+$/.test(String(f.ruleId)) ? String(f.ruleId) : 'HYG-UNKNOWN';
    const hash = /^[0-9a-f]{8}$/.test(String(f.hash)) ? f.hash : '?';
    return `${rule} ${String(f.path)}:${Number(f.line) || 0} len=${Number(f.length) || 0} hash=${hash}`;
  }).join('\n');
}
