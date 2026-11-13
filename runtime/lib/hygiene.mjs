// Gate 0 host/secret hygiene checks.
//
// Deterministic, zero dependencies, no network, no model. This module can only
// report findings; it never writes anything and never echoes matched text.
//
// Findings have exactly these fields: { ruleId, path, line, length, hash }.
//   - `hash` is the first 8 hex characters of HMAC-SHA256(salt, ruleId + matched text). The
//     salt is random per scanHygiene call (or the caller-supplied `salt` option) and is never
//     output, so a hash cannot be brute-forced offline and only de-duplicates inside one run.
//   - `length` is 0 for low-entropy rules (IP, HOST, USER, FQDN, HOMEPATH); for credentials
//     and encoded blobs it is the length rounded up to a multiple of 16.
//   - A path that itself triggers a finding (or holds control / bidi / format characters, or is
//     very long) is reported as `<path:HASH8>` (keyed hash), never echoed.
//   - Metadata is reported as `<metadata:commit#N>`, `<metadata:author#N>`,
//     `<metadata:prTitle>`, `<metadata:prBody>`, `<metadata:branch>` (N is
//     1-based). Multi-line fields (commit messages, PR body) use real 1-based
//     line numbers; single-valued fields and added paths use line 0.
//
// Matching works on several views of every line (raw, Unicode-normalized, unescaped /
// de-obfuscated, joined across continued lines). Limits (line windows, decode counts, total
// bytes) FAIL CLOSED: hitting one throws HygieneError('LIMIT'), which the caller maps to a
// block; nothing is ever skipped silently.
//
// Test-fake allowlist (`allowlist.testFakes`): entries are { path, hash } where `hash` is the
// FULL sha256 of the matched value (see `fakeHash`). Comparison happens inside the scanner;
// the value is never printed, and the printed per-run keyed hash is unrelated to it.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join, isAbsolute, sep } from 'node:path';

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

// Longest first so `home.arpa` wins over `arpa`-less alternatives.
const PRIVATE_SUFFIXES = ['home.arpa', 'localdomain', 'intranet', 'internal', 'private', 'corp', 'local', 'home', 'lan', 'lab', 'priv'];
const MAX_DEPTH = 3;
const MAX_LINE = 65536; // longer lines are scanned in overlapping windows
const WINDOW_OVERLAP = 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_DECODE_PER_LINE = 256;
const MAX_DECODE_TOTAL = 50000;
const MAX_DENYLIST_BYTES = 256 * 1024;
const MAX_DENYLIST_ENTRIES = 5000;
const MAX_ALLOWLIST = 10000;

export class HygieneError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HygieneError';
    this.code = code;
  }
}

function checkDeadline(deadline) {
  if (deadline !== undefined && Date.now() > deadline) throw new HygieneError('TIMEOUT', 'gate0: hygiene scan timed out');
}

// ---------------------------------------------------------------------------
// Normalization (Unicode, escapes, obfuscation)
// ---------------------------------------------------------------------------

// Hangul filler code points (U+115F, U+1160, U+3164, U+FFA0) are listed as numbers so no
// escape sequence that decodes to CJK text appears in this source.
const FILLER_CODES = [0x115f, 0x1160, 0x3164, 0xffa0];
const STRIP_RE = new RegExp(`[\\p{Cf}\\p{Mn}\\p{Cc}${String.fromCodePoint(...FILLER_CODES)}]`, 'gu');
const CONTROL_ONLY_RE = /[\p{Cf}\p{Cc}]/u;

// Cheap confusable folding (Cyrillic / Greek / dotless forms to Latin), applied after lowercasing.
const CONFUSABLES = new Map([
  [0x430, 'a'], [0x435, 'e'], [0x43e, 'o'], [0x440, 'p'], [0x441, 'c'], [0x445, 'x'], [0x443, 'y'],
  [0x456, 'i'], [0x458, 'j'], [0x455, 's'], [0x501, 'd'], [0x51b, 'q'], [0x51d, 'w'], [0x4bb, 'h'],
  [0x44c, 'b'], [0x43a, 'k'], [0x43d, 'h'], [0x442, 't'], [0x43c, 'm'], [0x261, 'g'], [0x3bf, 'o'],
  [0x3b1, 'a'], [0x3b5, 'e'], [0x3b9, 'i'], [0x3ba, 'k'], [0x3bd, 'v'], [0x3c1, 'p'], [0x3c4, 't'],
  [0x3c5, 'u'], [0x3c7, 'x'], [0x131, 'i'], [0x17f, 's'], [0x1d00, 'a'], [0x1d0f, 'o'],
]);

function foldConfusables(s) {
  let out = '';
  for (const ch of s) out += CONFUSABLES.get(ch.codePointAt(0)) ?? ch;
  return out;
}

/** NFKC, with format controls / zero-width / bidi / combining marks removed. Case is kept. */
export function normalizeText(s) {
  return String(s).normalize('NFKD').replace(STRIP_RE, '').normalize('NFKC');
}

/** Normalized and case-folded view used for denylisted names. */
function foldName(s) {
  return foldConfusables(normalizeText(s).toLowerCase().replace(/\u00df/g, 'ss')).toLowerCase();
}

const NAMED_ENTITIES = { period: '.', sol: '/', bsol: '\\', colon: ':', lowbar: '_', amp: '&', hyphen: '-', dash: '-', commat: '@', lsqb: '[', rsqb: ']', lpar: '(', rpar: ')', plus: '+', quot: '"', apos: "'", lt: '<', gt: '>', num: '#', dollar: '$', percnt: '%' };

function safeFromCodePoint(n) {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
}

/** Decode escape sequences, entities, defang notation and string concatenation. */
function deobfuscate(s) {
  let t = s;
  t = t.replace(/&#x([0-9a-fA-F]{1,6});?/g, (_, h) => safeFromCodePoint(parseInt(h, 16)));
  t = t.replace(/&#(\d{1,7});?/g, (_, d) => safeFromCodePoint(parseInt(d, 10)));
  t = t.replace(/&([a-z]{2,8});/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
  t = t.replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => safeFromCodePoint(parseInt(h, 16)));
  t = t.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  t = t.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8) & 0xff));
  t = t.replace(/\\\//g, '/');
  // defang: [.] (.) {.} [dot] (dot) and spaced separators between digits
  t = t.replace(/\s{0,8}[[({]\s{0,8}(?:\.|dot)\s{0,8}[\])}]\s{0,8}/gi, '.');
  t = t.replace(/(?<=\d)[ \t]{1,8}\.[ \t]{1,8}(?=\d)/g, '.');
  t = t.replace(/(?<=\d)[ \t]{1,8}dot[ \t]{1,8}(?=\d)/gi, '.');
  t = t.replace(/\[\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\]/g, '$1.$2.$3.$4');
  // string concatenation / adjacent literals: "ab" + "cd" -> abcd
  t = t.replace(/(["'`])\s{0,8}\+?\s{0,8}\1(?=\S)/g, '');
  t = t.replace(/["'`]\s{0,8}\+\s{0,8}["'`]/g, '');
  return t;
}

function buildViews(text) {
  const views = [text];
  const norm = normalizeText(text);
  if (norm !== text) views.push(norm);
  const de = deobfuscate(norm);
  if (de !== views[views.length - 1]) views.push(de);
  return views;
}

// ---------------------------------------------------------------------------
// Denylist
// ---------------------------------------------------------------------------

const NAME_OK = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,252}$/u;

function normalizeNames(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > MAX_DENYLIST_ENTRIES) throw new HygieneError('DENYLIST_INVALID', 'gate0: denylist is invalid');
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') throw new HygieneError('DENYLIST_INVALID', 'gate0: denylist is invalid');
    const n = foldName(item.trim());
    if (!NAME_OK.test(n)) throw new HygieneError('DENYLIST_INVALID', 'gate0: denylist is invalid');
    out.push(n);
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

const EMPTY_DENYLIST = () => ({ hostnames: { distinctive: [], common: [] }, usernames: { distinctive: [], common: [] } });

function insideOf(child, parent) {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
}

// The production location must be trustworthy: absolute, outside the reviewed repository,
// no symlinks, a regular file that is not group/other writable and owned by the current user
// or root, and of bounded size. Every violation is DENYLIST_UNTRUSTED (fixed message).
function readTrustedDenylist(home, repoRoot) {
  const bad = () => new HygieneError('DENYLIST_UNTRUSTED', 'gate0: denylist location is not trusted');
  if (!isAbsolute(home)) throw bad();
  const dir = join(home, 'gate0');
  const file = join(dir, 'denylist.json');
  let st;
  try {
    const realHome = realpathSync(home);
    if (realHome !== home && realpathSync(join(home)) !== realHome) throw bad();
    for (const p of [dir, file]) if (lstatSync(p).isSymbolicLink()) throw bad();
    const realFile = realpathSync(file);
    if (!insideOf(realFile, realHome)) throw bad();
    const roots = [repoRoot, process.cwd()].filter((r) => typeof r === 'string' && r);
    for (const r of roots) {
      let rr;
      try { rr = realpathSync(r); } catch { continue; }
      if (insideOf(realFile, rr) && !insideOf(rr, realFile)) throw bad();
    }
    st = statSync(file);
  } catch (err) {
    if (err instanceof HygieneError) throw err;
    if (err && err.code === 'ENOENT') throw Object.assign(new Error('x'), { enoent: true });
    throw new HygieneError('DENYLIST_UNREADABLE', 'gate0: denylist unreadable');
  }
  if (!st.isFile() || st.size > MAX_DENYLIST_BYTES) throw bad();
  if ((st.mode & 0o022) !== 0) throw bad();
  if (typeof process.getuid === 'function' && st.uid !== process.getuid() && st.uid !== 0) throw bad();
  return readFileSync(file, 'utf8');
}

/**
 * Load the hostname/username denylist.
 * Production file: $RT_HOME/gate0/denylist.json (outside the repository).
 * A `fixture` is honored only on a non-host run. On a host run it is ignored: the
 * production file must be present, trusted (absolute RT_HOME, outside the repo and cwd, regular
 * file, not group/other writable, bounded size), readable and valid, otherwise this throws (fail closed).
 * Error messages are fixed strings: they never contain paths, file content or parser output.
 */
export function loadDenylist({ env = process.env, hostRun = false, fixture, repoRoot } = {}) {
  let result;
  if (fixture !== undefined && !hostRun) {
    result = normalizeDenylist(fixture);
  } else {
    const home = env && typeof env.RT_HOME === 'string' ? env.RT_HOME : '';
    if (!home) {
      if (hostRun) throw new HygieneError('DENYLIST_MISSING', 'gate0: denylist unavailable on a host run');
      return EMPTY_DENYLIST();
    }
    let text;
    try {
      text = hostRun ? readTrustedDenylist(home, repoRoot) : readFileSync(join(home, 'gate0', 'denylist.json'), 'utf8');
    } catch (err) {
      if (err instanceof HygieneError) throw err;
      if (hostRun) throw new HygieneError('DENYLIST_MISSING', 'gate0: denylist unavailable on a host run');
      if (err && (err.code === 'ENOENT' || err.enoent)) return EMPTY_DENYLIST();
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

/** Unkeyed 8-hex digest. Only for non-secret inputs; findings use a keyed hash instead. */
export function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

/** Full sha256 (64 hex) of a value: the form `allowlist.testFakes[].hash` must use. Never printed. */
export function fakeHash(text) {
  return createHash('sha256').update(String(text)).digest('hex');
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

// A fake marker exempts a value only when the ENTIRE value is a fake: marker words plus
// harmless filler (digits, separators, one single-case word of bounded length). A marker glued
// to a random string does not qualify.
function isFakeValue(v) {
  if (!/EXAMPLE|FAKE/.test(v)) return false;
  const rest = v.replace(/EXAMPLE|FAKE/g, '').replace(/[_-]+/g, '');
  const m = /^((?:[A-Z]{0,20}|[a-z]{0,20}))[0-9]{0,16}$/.exec(rest);
  // The filler word must be low-entropy: a random run glued to a marker is a real value.
  return m !== null && shannon(m[1]) < 3.0;
}

// Closed placeholder set: <word>, $NAME / ${NAME}, %NAME%, {name} / {{ name }}, and `*`.
// Nothing else is exempt by prefix: a real value that starts with `$` or `{` is still a value.
function isPlaceholder(x) {
  if (x === '*') return true;
  if (/^<[A-Za-z0-9_-]*>$/.test(x)) return true;
  if (/^\$\{?(?:[A-Z_][A-Z0-9_]*|[a-z_]+)\}?$/.test(x)) return true;
  if (/^%[A-Za-z_]+%$/.test(x)) return true;
  if (/^\{\{?\s*[A-Za-z_][A-Za-z_.]*\s*\}?\}$/.test(x)) return true;
  return false;
}

export function isAllowedHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.test') || h.endsWith('.invalid')) return true;
  return ALWAYS_ALLOWED_HOSTS.some((a) => h === a || h.endsWith('.' + a));
}

// ---------------------------------------------------------------------------
// IP rules
// ---------------------------------------------------------------------------

// A netmask word anywhere on the line gives a bit-pattern quad the meaning "mask".
const NETMASK_WORD_RE = /\b(?:net)?masks?\b|\bsubnets?\b|\bprefix(?:es)?\b/i;
// A `/24`-style prefix length on the line (not glued to a word or a dotted number).
const PREFIX_LEN_RE = /(?<![\w.])\/\d{1,2}(?!\d)/;

function ipv4Allowed(o, maskContext) {
  const [a, b, c] = o;
  if (a === 127) return true; // loopback
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (o.every((x) => x === 0)) return true; // unspecified
  // A contiguous netmask (all-ones prefix, then zeros) is not an address, but only when the
  // line says so; a bare bit-pattern quad (e.g. a first octet of 128 or 192) is a public address.
  const bits = o.map((x) => x.toString(2).padStart(8, '0')).join('');
  if (maskContext && /^1+0*$/.test(bits)) return true;
  return false;
}

const QUAD_BEFORE_RE = /(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}\s+$/;
function hasMaskContext(text, index, end) {
  if (/\/\d/.test(text.slice(end, end + 2))) return false;
  if (NETMASK_WORD_RE.test(text)) return true;
  if (PREFIX_LEN_RE.test(text)) return true;
  return QUAD_BEFORE_RE.test(text.slice(Math.max(0, index - 20), index));
}

// One address segment: decimal (padded to any length), or a 0x hex number.
function segValues(seg) {
  const out = [];
  if (/^0[xX]/.test(seg)) out.push(parseInt(seg.slice(2), 16));
  else {
    out.push(parseInt(seg, 10));
    if (/^0\d+$/.test(seg) && !/[89]/.test(seg)) out.push(parseInt(seg, 8)); // inet_aton octal
  }
  return out;
}

function intToOctets(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

const DOTTED_RE = /(?<!\d)(?<!\d\.)((?:0[xX][0-9a-fA-F]{1,8}|\d{1,8})(?:\.(?:0[xX][0-9a-fA-F]{1,8}|\d{1,8})){2,3})(?![\d.]*\d)(?![A-Za-z0-9_]|\.[A-Za-z0-9])/g;
// Context that makes a bare integer / hex / three-part number an address.
const ADDR_CONTEXT_RE = /(?:\b(?:ping|curl|wget|ssh|scp|sftp|nc|ncat|telnet|ftp|host|hostname|ip|addr|address|server|connect|dest|remote|target|inet|bind|listen)\b|@|:\/\/|(?:^|\s)-h)[\s=:"'[(]{0,8}$/i;

// Narrow version exemption (H-53 trade-off). A four-part number is a VERSION, not an address,
// only when the whole added line has one of two exact shapes AND the file kind matches:
//  (a) a manifest / lockfile key: the key is exactly `version` (JSON `"version": "N"`, TOML
//      `version = "N"`, YAML `version: N`, lockfile `version "N"`) in package.json, package-lock.json,
//      npm-shrinkwrap.json, composer.json, composer.lock, any `*.lock`, pyproject.toml,
//      Cargo.toml, pubspec.yaml or Chart.yaml;
//  (b) a release heading in a prose file (.md/.markdown/.txt/.rst): `#`-marker, optional `[`,
//      optional `v`, the number, optional `]`, and optionally ` - date` or ` (date)`.
// Accepted trade-off: a `version` key holding a plausible public address is exempt, because that
// key overwhelmingly holds a version. A standalone `v` prefix also identifies a version; a
// number whose octets form a private, CGNAT or link-local address is never exempt.
// Only the exact number string of that one line is skipped; every other match is still scanned.
const VERSION_QUAD = '((?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3})';
const VERSION_KEY_LINE_RE = new RegExp(`^\\s*(?:"version"\\s*:|version(?:\\s*[:=]|\\s))\\s*(["']?)${VERSION_QUAD}\\1\\s*,?\\s*$`);
const VERSION_HEADING_RE = new RegExp(`^#{1,6}[ \\t]+\\[?v?${VERSION_QUAD}\\]?(?:[ \\t]+-[ \\t]+\\d{4}-\\d{2}-\\d{2}|[ \\t]+\\(\\d{4}-\\d{2}-\\d{2}\\))?[ \\t]*$`);
const VERSION_MANIFEST_RE = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|composer\.json|composer\.lock|pyproject\.toml|Cargo\.toml|pubspec\.yaml|Chart\.yaml|[^/\\]+\.lock)$/;
const VERSION_PROSE_RE = /\.(?:md|markdown|txt|rst)$/i;

function isNeverVersion(o) {
  const [a, b] = o;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}

// Returns the exact exempt number string for an added line, or null.
function versionQuadOf(path, text) {
  if (typeof path !== 'string' || typeof text !== 'string' || text.length > 400) return null;
  const file = path.split(/[\\/]/).pop();
  let m = null;
  if (VERSION_MANIFEST_RE.test(file)) m = VERSION_KEY_LINE_RE.exec(text);
  const quad = m ? m[2] : null;
  let found = quad;
  if (found === null && VERSION_PROSE_RE.test(file)) {
    m = VERSION_HEADING_RE.exec(text);
    found = m ? m[1] : null;
  }
  if (found === null) return null;
  const o = found.split('.').map(Number);
  if (o.some((x) => x > 255) || isNeverVersion(o)) return null;
  return found;
}

function findIPv4(text, out, versionQuads) {
  for (const m of text.matchAll(DOTTED_RE)) {
    if (text[m.index - 1] === 'v' && (m.index < 2 || !/[\w]/.test(text[m.index - 2])) && !/[\w-]/.test(text[m.index + m[0].length] || '') && !isNeverVersion(m[1].split('.').map(Number))) continue;
    const segs = m[1].split('.');
    const end = m.index + m[0].length;
    if (segs.length === 3) {
      // a.b.c is an address only in an address context (a version-like triple is not)
      if (!ADDR_CONTEXT_RE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
      const v = segValues(segs[2]);
      const first = segValues(segs[0]);
      const second = segValues(segs[1]);
      let flagged = false;
      for (const a of first) for (const b of second) for (const c of v) {
        if (a > 255 || b > 255 || c > 0xffff) continue;
        if (!ipv4Allowed([a, b, (c >> 8) & 255, c & 255], false)) flagged = true;
      }
      if (flagged) out.push({ ruleId: RULES.IP, text: m[1] });
      continue;
    }
    if (segs.length !== 4) continue;
    if (text[end] === '.' && /\d/.test(text[end + 1] || '')) continue; // five-part version-like string
    if (versionQuads !== undefined && versionQuads.has(m[1])) continue; // recognized version context
    const lists = segs.map(segValues);
    const maskCtx = hasMaskContext(text, m.index, end);
    let flagged = false;
    let valid = false;
    const pick = (i, acc) => {
      if (i === 4) {
        valid = true;
        if (!ipv4Allowed(acc, maskCtx)) flagged = true;
        return;
      }
      for (const v of lists[i]) if (v <= 255) pick(i + 1, [...acc, v]);
    };
    pick(0, []);
    if (valid && flagged) out.push({ ruleId: RULES.IP, text: m[1] });
  }
  // Bare integer (decimal / 0x hex) in an address context.
  for (const m of text.matchAll(/(?<![\w.])(0[xX][0-9a-fA-F]{8}|\d{8,10})(?![\w.])/g)) {
    if (!ADDR_CONTEXT_RE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
    const n = /^0[xX]/.test(m[1]) ? parseInt(m[1], 16) : parseInt(m[1], 10);
    if (!(n >= 0x1000000 && n <= 0xffffffff)) continue;
    if (!ipv4Allowed(intToOctets(n), false)) out.push({ ruleId: RULES.IP, text: m[1] });
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
  if (g[0] === 0x2001 && g[1] === 0x0db8) {
    // documentation prefix, unless the low 32 bits spell a non-allowed IPv4 address
    if (g.slice(2, 6).every((x) => x === 0) && (g[6] >> 8) !== 0) return ipv4Allowed([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255], false);
    return true;
  }
  return false;
}

// A letters-only candidate (no decimal digit), for example a short or mixed-case pair of
// words joined by a double colon, is a valid IPv6 value when it parses. In a code file a
// word-like pair (mixed letter case, or fewer than 4 hex digits in total) that is not in a
// host context is a scope-resolution path and is skipped. A single-case token with 4 or more
// hex digits is flagged in code as well. Prose files, commit messages, PR text, branch names
// and paths never get the exemption.
function plausibleLetterOnlyIPv6(s) {
  const halves = s.split('::');
  if (halves.length === 1) return s.split(':').length === 8;
  return halves[0] !== '' || halves[1] !== '';
}

function looksLikeScopePath(s) {
  if (/[a-f]/.test(s) && /[A-F]/.test(s)) return true;
  return s.replace(/:/g, '').length < 4;
}

const IPV6_HOST_WORD_RE = /(?<![A-Za-z])(?:ip|addr|address|host|hostname|ipv6|inet6)(?![A-Za-z])/i;
function inIPv6HostContext(text, index, end) {
  if (text[index - 1] === '[' || text[end] === ']') return true;
  if (text[index - 1] === '@') return true;
  if (inRemoteCommandContext(text, index)) return true;
  return IPV6_HOST_WORD_RE.test(text);
}

function findIPv6(text, out, codeFile = false) {
  const re = /[0-9A-Fa-f:]{2,}(?![A-Za-z0-9_:])(?!\.\d)/g;
  for (const m of text.matchAll(re)) {
    let s = m[0];
    let index = m.index;
    const prev = index > 0 ? text[index - 1] : '';
    // A single colon glued to a preceding key word (`ip:` or `addr_` before an address) belongs to the key.
    if (s[0] === ':' && s[1] !== ':' && prev !== '' && /[A-Za-z0-9_-]/.test(prev)) {
      s = s.slice(1);
      index += 1;
    } else if (prev !== '' && /[A-Za-z0-9.:]/.test(prev)) {
      continue;
    } else if (prev === '-' || prev === '_') {
      // glued by a dash / underscore: keep
    }
    if (s.length < 2) continue;
    if (!/\d/.test(s) && !plausibleLetterOnlyIPv6(s)) continue;
    if (!s.includes('::') && (s.match(/:/g) || []).length !== 7) continue;
    const groups = parseIPv6(s);
    if (!groups) continue;
    if (ipv6Allowed(groups)) continue;
    if (!/\d/.test(s) && codeFile && looksLikeScopePath(s) && !inIPv6HostContext(text, index, index + s.length)) continue;
    out.push({ ruleId: RULES.IP, text: s });
  }
}

// ---------------------------------------------------------------------------
// Denylisted names
// ---------------------------------------------------------------------------

const REMOTE_CMDS = 'ssh|scp|sftp|rsync|mosh|ping|curl|wget|nc|ncat|telnet|ftp|traceroute|nslookup|dig';
const REMOTE_COMMAND_RE = new RegExp(`(?<![A-Za-z0-9_.-])(?:${REMOTE_CMDS})(?![A-Za-z0-9_-])`, 'i');

function inRemoteCommandContext(text, index) {
  // Only the current command segment counts (a `;`, `&` or `|` starts a new one).
  const segment = text.slice(0, index).split(/[;&|]/).pop();
  return REMOTE_COMMAND_RE.test(segment);
}

const matcherCache = new WeakMap();

function buildNameMatchers(denylist) {
  if (matcherCache.has(denylist)) return matcherCache.get(denylist);
  const distinctive = [];
  const contexts = [];
  const add = (kind, rule) => {
    for (const name of kind.distinctive) {
      distinctive.push({ ruleId: rule, name, squeezed: name.replace(/[\s_.-]+/g, '') });
    }
    for (const name of kind.common) {
      const n = escapeRe(name);
      const suffixes = PRIVATE_SUFFIXES.join('|');
      const list = [
        // user@NAME
        `(?<![a-z0-9_.+-])[a-z0-9_.+-]+@${n}(?![a-z0-9_-])`,
        // NAME@host (not an example/test/invalid mail domain)
        `(?<![a-z0-9_.+-])${n}@(?!example\\.(?:com|org|net)\\b)(?![a-z0-9.-]*\\.(?:test|invalid)\\b)[a-z0-9_.-]+`,
        // remote command forms: NAME is one of the first arguments
        `\\b(?:${REMOTE_CMDS})\\s+(?:\\S+\\s+){0,5}?(?:[a-z0-9_.+-]+@)?${n}(?=[\\s:'"\`/]|$)`,
        // URL authority
        `:\\/\\/(?:[^\\s\\/@]*@)?${n}(?![a-z0-9_-])`,
        // NAME plus a private suffix
        `(?<![a-z0-9_-])${n}\\.(?:${suffixes})(?![a-z0-9_-])`,
        // UNC share
        `\\\\\\\\${n}(?![a-z0-9_-])`,
      ];
      if (rule === RULES.HOST) {
        list.push(`(?<![a-z0-9_.-])(?:[a-z0-9_.-]*?(?:host|hostname|server|addr|address|endpoint|url|node)|-h)["']?\\s{0,16}[:= ]\\s{0,16}["']?${n}(?![a-z0-9_-])`);
        list.push(`(?<![a-z0-9_.+-])${n}:\\d{2,5}(?!\\d)`);
      } else {
        list.push(`(?<![a-z0-9_.-])(?:[a-z0-9_.-]*?(?:user|username|login|owner|account)|-u)["']?\\s{0,16}[:= ]\\s{0,16}["']?${n}(?![a-z0-9_-])`);
      }
      for (const c of list) contexts.push({ ruleId: rule, name, re: new RegExp(c, 'g') });
    }
  };
  add(denylist.hostnames, RULES.HOST);
  add(denylist.usernames, RULES.USER);
  const built = { distinctive, contexts };
  matcherCache.set(denylist, built);
  return built;
}

function findNames(text, denylist, out) {
  const { distinctive, contexts } = buildNameMatchers(denylist);
  const view = foldName(text);
  const squeezed = view.replace(/[\s_.-]+/g, '');
  for (const d of distinctive) {
    if (view.includes(d.name) || (d.squeezed.length >= 4 && squeezed.includes(d.squeezed))) {
      out.push({ ruleId: d.ruleId, text: d.name });
    }
  }
  for (const { ruleId, name, re } of contexts) {
    re.lastIndex = 0;
    if (re.test(view)) out.push({ ruleId, text: name });
  }
}

// ---------------------------------------------------------------------------
// Private-suffix FQDNs
// ---------------------------------------------------------------------------

// A JS member access whose last property reads like a private suffix is not a host. The
// exemption applies ONLY to added lines in code files, never in comments, env-file style
// `KEY=value` lines, string literals, host positions (after `://` or `@`, or a remote command).
const MEMBER_ROOTS = new Set([
  'process', 'env', 'this', 'self', 'user', 'users', 'os', 'config', 'cfg', 'conf', 'settings',
  'options', 'opts', 'ctx', 'context', 'app', 'args', 'props', 'state', 'req', 'res', 'obj',
  'data', 'window', 'document', 'global', 'globalthis', 'module', 'exports', 'paths', 'dirs',
  'path', 'profile', 'account', 'session', 'info', 'result', 'item', 'entry',
]);

const CODE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|json|jsonc|json5|vue|svelte|py|rb|go|rs|java|kt|cs|php|c|h|cc|cpp|hpp)$/i;

/** True for source-code paths where a JS-style member access can legitimately appear. */
function isCodePath(path) {
  if (typeof path !== 'string' || path === '') return false;
  const file = path.split(/[\\/]/).pop();
  return CODE_EXT_RE.test(file) && !DOC_EXT_RE.test(file);
}

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
  const before = text.slice(0, index);
  if (/\/\/|\/\*|<!--|(?:^|\s)#|(?:^|\s)--\s|^\s*\*/.test(before)) return false; // comment text
  if (/^\s*[A-Za-z_][\w.]*=\s*["']?$/.test(before)) return false; // env-file / heredoc value
  const p1 = index > 0 ? text[index - 1] : '';
  const p2 = index > 1 ? text[index - 2] : '';
  if (p1 === '@' || (p1 === '/' && p2 === '/')) return false;
  if (inRemoteCommandContext(text, index)) return false;
  return true;
}

const FQDN_RE = new RegExp(
  `(?<![A-Za-z0-9_.\\-])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+(?:${PRIVATE_SUFFIXES.map(escapeRe).join('|')})(?!\\.?[A-Za-z0-9_-])`,
  'gi',
);

function findFqdn(text, out, codeFile) {
  for (const m of text.matchAll(FQDN_RE)) {
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

const SEG = '(<[A-Za-z0-9_-]*>|\\$\\{[A-Za-z_][A-Za-z0-9_]*\\}|%[A-Za-z_]+%|[^\\s\\/\\\\\'"`<>()\\[\\]{},;:*|]+)';

// A branch name cannot start with a slash, so a home path shows up as segments. Also used for
// every added path.
function findHomePathSegments(text, out) {
  const re = /(?:^|\/)(?:home|Users)\/(<[^>\s]*>|[A-Za-z0-9_.-]+)/gi;
  for (const m of text.matchAll(re)) {
    if (isPlaceholder(m[1])) continue;
    out.push({ ruleId: RULES.HOMEPATH, text: m[0].replace(/^\//, '') });
  }
}

const HOME_RES = [
  new RegExp(`(?<![A-Za-z0-9_.\\-~$])\\/(?:var|usr|export|data)\\/home\\/${SEG}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9_.\\-~$])\\/mnt\\/[A-Za-z]\\/Users\\/${SEG}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9_.\\-~$])\\/(?:home|Users)\\/${SEG}`, 'gi'),
  new RegExp(`\\\\\\\\wsl[^\\s\\\\]{0,12}\\\\[^\\s\\\\]{1,40}\\\\home\\\\${SEG}`, 'gi'),
  new RegExp(`(?<![A-Za-z0-9])[A-Za-z]:[\\\\\\/]{1,4}Users[\\\\\\/]{1,4}${SEG}`, 'gi'),
];

function findHomePaths(text, out) {
  for (const re of HOME_RES) {
    for (const m of text.matchAll(re)) {
      if (isPlaceholder(m[1])) continue;
      out.push({ ruleId: RULES.HOMEPATH, text: m[0] });
    }
  }
  for (const m of text.matchAll(new RegExp('(?<![A-Za-z0-9_.\\-~$])\\/ro' + 'ot\\/', 'g'))) {
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

// Data table: one entry per vendor token shape. Literals that a privacy scanner would flag are
// assembled from pieces so this file holds no token-prefix or key-header literal.
const j = (...p) => p.join('');
const TOKEN_TABLE = [
  ['github-classic', new RegExp(j('gh[pousr]', '_[A-Za-z0-9]{16,}'), 'g')],
  ['github-fine', new RegExp(j('github', '_pat_[A-Za-z0-9_]{20,}'), 'g')],
  ['gitlab', /glpat-[A-Za-z0-9_-]{16,}/g],
  ['aws-key-id', new RegExp('(?<![A-Za-z0-9])(?:' + ['AK', 'AS'].map((x) => x + 'IA').join('|') + ')[0-9A-Z]{16}(?![A-Za-z0-9])', 'g')],
  ['slack', /xox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['slack-webhook', /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{16,}/g],
  ['google-api', /AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g],
  ['npm', /npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g],
  ['jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['stripe', new RegExp(j('[sr]k', '_(?:live|test)_[A-Za-z0-9]{16,}'), 'g')],
  ['twilio', /(?<![A-Za-z0-9])(?:SK|AC)[0-9a-f]{32}(?![A-Za-z0-9])/g],
  ['sendgrid', new RegExp(j('SG', '\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}'), 'g')],
  ['huggingface', /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{30,}/g],
  ['pypi', /pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/g],
  ['docker', /dckr_pat_[A-Za-z0-9_-]{20,}/g],
  ['digitalocean', /dop_v1_[a-f0-9]{64}/g],
  ['shopify', /shp(?:at|ss|ca|pa)_[a-f0-9]{32}/g],
  ['telegram', /(?<![A-Za-z0-9])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g],
  // The header is assembled from pieces so this file holds no key-header literal.
  ['private-key-header', new RegExp('-'.repeat(5) + 'BEGIN [A-Z0-9 ]*PRIV' + 'ATE KEY(?: BLOCK)?' + '-'.repeat(5), 'g')],
  ['openssh-magic', /(?<![A-Za-z0-9+/])b3BlbnNzaC1[A-Za-z0-9+/]{40,}={0,2}/g],
  ['der-key-body', /^[ \t]*MII[A-Za-z0-9+/]{60,}={0,2}[ \t]*$/gm],
];

// sk- style keys need a digit and a letter, so ordinary hyphenated words pass.
const SK_PATTERN = /(?<![A-Za-z0-9])sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g;

const URL_USERINFO = /\b[a-z][a-z0-9+.-]{0,31}:\/\/([^\s/?#@'"<>]+)@[^\s/'"<>]+/gi;

// Keyword tokens (after splitting the key on camelCase, `_`, `-`, `.`).
const STRONG_KEYS = new Set(['password', 'passwords', 'passwd', 'pwd', 'pass', 'passphrase', 'secret', 'secrets', 'token', 'tokens', 'apikey', 'credential', 'credentials', 'privatekey', 'accesskey', 'clientsecret', 'signingkey', 'encryptionkey', 'auth', 'authorization', 'bearer', 'salt']);

function keyTokens(key) {
  const toks = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map((t) => t.toLowerCase());
  const out = new Set(toks);
  for (let i = 0; i + 1 < toks.length; i++) out.add(toks[i] + toks[i + 1]);
  return out;
}

function isSecretKey(key) {
  for (const t of keyTokens(key)) if (STRONG_KEYS.has(t)) return true;
  return false;
}

function charClasses(v) {
  return (/[a-z]/.test(v) ? 1 : 0) + (/[A-Z]/.test(v) ? 1 : 0) + (/\d/.test(v) ? 1 : 0) + (/[^A-Za-z0-9]/.test(v) ? 1 : 0);
}

function looksLikeIdentifier(v) {
  const words = v.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [];
  return words.length > 0 && v.length / words.length >= 3;
}

function highEntropy(v) {
  if (v.length < 16) return false;
  if (/^[A-Za-z]+$/.test(v)) {
    if (!/[a-z]/.test(v)) return shannon(v) >= 3.5;
    if (/[A-Z]/.test(v) && looksLikeIdentifier(v)) {
      const run = (v.match(/[a-z]{16,}/g) || []).find((r) => shannon(r) >= 3.5);
      return run !== undefined;
    }
    return shannon(v) >= 3.5;
  }
  if (/^[A-Za-z0-9_-]+$/.test(v) && !/\d/.test(v) && /[_-]/.test(v)) {
    // snake / kebab names: judge the longest letters-only run
    return (v.match(/[A-Za-z]{14,}/g) || []).some((r) => shannon(r) >= 3.5);
  }
  if (!/\d/.test(v) && /[A-Za-z]/.test(v) && /[^A-Za-z0-9_.-]/.test(v)) return shannon(v) >= 3.25;
  if (!/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
  return shannon(v) >= 3.25;
}

const REFERENCE_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/;

// Is the value of a secret-named key a real-looking secret? Closed placeholder set only.
function credentialValue(raw) {
  let v = raw;
  if (v.includes('(') && v.endsWith(')')) return null; // function call
  const cut = v.search(/[&(<]/);
  if (cut > 0) v = v.slice(0, cut);
  v = v.replace(/[,;)\]}]+$/, '');
  if (v.length < 8 || isPlaceholder(v)) return null;
  if (REFERENCE_RE.test(v)) return null;
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(v) && (!/\d/.test(v) || !highEntropy(v))) return null;
  if (/^(?:true|false|null|none|undefined|string|required|optional)$/i.test(v)) return null;
  if (highEntropy(v)) return v;
  if (/^[a-z]+\d{0,3}$/.test(v) && !/[0-9]/.test(v)) return null; // a plain lowercase word
  if (/[^A-Za-z0-9_.-]/.test(v) && charClasses(v) >= 3) return v;
  if (/\d/.test(v) && /[A-Za-z]/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && shannon(v) >= 2.8) return v;
  if (/\d/.test(v) && /[a-z]/.test(v) && v.length >= 12 && shannon(v) >= 3.0) return v;
  return null;
}

const KV_RE = /(?<![A-Za-z0-9_$.-])([A-Za-z_$][A-Za-z0-9_$.-]{0,80})(["'\]]?)[ \t]*(?::=|=>|[:=])[ \t]*(?:(["'`])([^"'`]{1,200})\3|([^\s"'`,;]+))/g;
const FLAG_RE = /(?<![A-Za-z0-9_-])--?([A-Za-z][A-Za-z0-9-]{1,60})(?:=|[ \t]+)(?:(["'`])([^"'`]{1,200})\2|([^\s"'`,;-][^\s"'`,;]*))/g;
const XML_RE = /<([A-Za-z_][A-Za-z0-9_.-]{0,60})(?:\s[^>]{0,200})?>([^<>]{1,200})<\/\1\s*>/g;
const BEARER_RE = /\b(?:bearer|basic)[ \t]+([A-Za-z0-9._~+/=-]{20,})/gi;

function findCredentials(text, out, allowFake) {
  const push = (value, shown) => {
    if (allowFake && isFakeValue(value)) return;
    out.push({ ruleId: RULES.CRED, text: shown });
  };
  for (const [, re] of TOKEN_TABLE) {
    for (const m of text.matchAll(re)) push(m[0], m[0]);
  }
  for (const m of text.matchAll(SK_PATTERN)) {
    if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0].slice(3))) push(m[0], m[0]);
  }
  for (const m of text.matchAll(URL_USERINFO)) {
    const ui = m[1];
    const colon = ui.indexOf(':');
    if (colon >= 0) {
      const pass = ui.slice(colon + 1);
      if (pass === '' || isPlaceholder(pass)) continue;
      push(pass, m[0]);
    } else if ((/^[0-9a-fA-F]{32,}$/.test(ui) || (ui.length >= 20 && shannon(ui) >= 3.5)) && !isPlaceholder(ui)) {
      push(ui, m[0]);
    }
  }
  for (const m of text.matchAll(KV_RE)) {
    if (!isSecretKey(m[1])) continue;
    const v = credentialValue(m[4] !== undefined ? m[4] : m[5]);
    if (v) push(v, v);
  }
  for (const m of text.matchAll(FLAG_RE)) {
    if (!isSecretKey(m[1])) continue;
    const v = credentialValue(m[3] !== undefined ? m[3] : m[4]);
    if (v) push(v, v);
  }
  for (const m of text.matchAll(XML_RE)) {
    if (!isSecretKey(m[1])) continue;
    const v = credentialValue(m[2].trim());
    if (v) push(v, v);
  }
  for (const m of text.matchAll(BEARER_RE)) {
    const v = m[1];
    if (isPlaceholder(v) || shannon(v) < 3.0 || charClasses(v) < 2) continue;
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
    return s.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
}

function decodeCandidates(text) {
  const views = [];
  for (const m of text.matchAll(/\S+/g)) {
    if (m[0].includes('%') && /%[0-9A-Fa-f]{2}/.test(m[0])) views.push({ source: m[0], decoded: decodePercent(m[0]) });
  }
  const seen = new Set();
  const add = (source, buf) => {
    if (buf.length < 6 || printableRatio(buf) < 0.95) return;
    const decoded = buf.toString('latin1');
    if (seen.has(decoded)) return;
    seen.add(decoded);
    views.push({ source, decoded });
  };
  for (const m of text.matchAll(/[A-Za-z0-9+/_-]{10,}={0,2}/g)) {
    const pieces = new Set([m[0]]);
    for (const piece of m[0].split(/[/_-]/)) if (piece.length >= 10) pieces.add(piece);
    for (const p of pieces) {
      const std = p.replace(/-/g, '+').replace(/_/g, '/');
      for (let off = 0; off < 3; off++) {
        if (std.length - off >= 8) add(p, Buffer.from(std.slice(off), 'base64'));
      }
      if (/^[0-9a-fA-F]{12,}$/.test(p) && p.length % 2 === 0) add(p, Buffer.from(p, 'hex'));
    }
  }
  return views;
}

function findEncoded(text, ctx, depth, out, opts) {
  if (depth >= MAX_DEPTH) return;
  const cands = decodeCandidates(text);
  if (cands.length > MAX_DECODE_PER_LINE) throw new HygieneError('LIMIT', 'gate0: hygiene scan limit exceeded');
  ctx.decodes += cands.length;
  if (ctx.decodes > MAX_DECODE_TOTAL) throw new HygieneError('LIMIT', 'gate0: hygiene scan limit exceeded');
  for (const { source, decoded } of cands) {
    if (decoded === source) continue;
    checkDeadline(ctx.deadline);
    if (scanText(decoded, ctx, depth + 1, { ...opts, versionQuads: undefined }).length > 0) out.push({ ruleId: RULES.ENC, text: source });
  }
}

// ---------------------------------------------------------------------------
// Text scanner
// ---------------------------------------------------------------------------

// `opts.allowFake` lets fake-marked credentials pass (test-fixture paths only). `opts.codeFile`
// enables the member-access FQDN and scope-path IPv6 exemptions (code files only).
function scanView(view, ctx, opts, out) {
  findIPv4(view, out, opts.versionQuads);
  findIPv6(view, out, opts.codeFile === true);
  findNames(view, ctx.denylist, out);
  findFqdn(view, out, opts.codeFile === true);
  findHomePaths(view, out);
  findCredentials(view, out, opts.allowFake === true);
}

function scanWindow(text, ctx, depth, opts) {
  const out = [];
  const views = buildViews(text);
  for (const v of views) {
    checkDeadline(ctx.deadline);
    scanView(v, ctx, opts, out);
  }
  checkDeadline(ctx.deadline);
  findEncoded(text, ctx, depth, out, opts);
  if (views.length > 1) findEncoded(views[views.length - 1], ctx, depth, out, opts);
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.ruleId}|${f.text.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function scanText(text, ctx, depth = 0, opts = {}) {
  if (typeof text !== 'string' || text.length === 0) return [];
  ctx.bytes += text.length;
  if (ctx.bytes > MAX_TOTAL_BYTES) throw new HygieneError('LIMIT', 'gate0: hygiene scan limit exceeded');
  if (text.length <= MAX_LINE) return scanWindow(text, ctx, depth, opts);
  // Long line: overlapping windows, so nothing is skipped and a match cannot straddle a seam.
  const out = [];
  const seen = new Set();
  for (let i = 0; i < text.length; i += MAX_LINE - WINDOW_OVERLAP) {
    for (const f of scanWindow(text.slice(i, i + MAX_LINE), ctx, depth, opts)) {
      const k = `${f.ruleId}|${f.text.toLowerCase()}`;
      if (!seen.has(k)) { seen.add(k); out.push(f); }
    }
    if (i + MAX_LINE >= text.length) break;
  }
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
  if (!Array.isArray(fakes) || fakes.length > MAX_ALLOWLIST) throw new HygieneError('ALLOWLIST_INVALID', 'gate0: allowlist is invalid');
  const set = new Set();
  for (const f of fakes) {
    if (!f || typeof f.path !== 'string' || typeof f.hash !== 'string' || !/^[0-9a-f]{64}$/.test(f.hash)) {
      throw new HygieneError('ALLOWLIST_INVALID', 'gate0: allowlist is invalid');
    }
    set.add(`${f.path}\u0000${f.hash}`);
  }
  return set;
}

const LOW_ENTROPY_RULES = new Set([RULES.IP, RULES.HOST, RULES.USER, RULES.FQDN, RULES.HOMEPATH]);

function makeSalt(salt) {
  if (salt === undefined) return randomBytes(32);
  if (typeof salt === 'string' && salt.length >= 8) return Buffer.from(salt, 'utf8');
  if (Buffer.isBuffer(salt) && salt.length >= 8) return salt;
  throw new HygieneError('INPUT_INVALID', 'gate0: salt is invalid');
}

// Multi-line constructs: a line that ends in a continuation (`\`, `+`, or a key with no value)
// is joined with the next consecutive added line, then scanned as one more line.
const CONTINUATION_RE = /(?:\\|\+|[:=][ \t]*[>|]?[+-]?|["'`][ \t]*,?)[ \t]*$/;

function joinedLines(entries) {
  const out = [];
  for (let i = 0; i + 1 < entries.length; i++) {
    const a = entries[i];
    const b = entries[i + 1];
    if (!Number.isInteger(a.line) || b.line !== a.line + 1 || !CONTINUATION_RE.test(a.text)) continue;
    const head = a.text.replace(/\\[ \t]*$/, '').replace(/\+[ \t]*$/, ' ');
    out.push({ path: a.path, line: a.line, text: (head + ' ' + b.text.trim()).slice(0, 4096), versionSrc: [a.text, b.text] });
  }
  return out;
}

// A PEM body without header: three or more consecutive added lines of 64-76 base64 characters.
function pemBodyLines(entries) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) out.push({ path: run[0].path, line: run[0].line, text: run[0].text });
    run = [];
  };
  for (const e of entries) {
    const ok = /^[A-Za-z0-9+/]{64,76}={0,2}$/.test(e.text.trim());
    if (ok && (run.length === 0 || e.line === run[run.length - 1].line + 1)) run.push(e);
    else { flush(); if (ok) run.push(e); }
  }
  flush();
  return out;
}

/**
 * Scan added lines, added/renamed paths and PR/commit metadata.
 * Returns findings: [{ ruleId, path, line, length, hash }] with no matched text, sorted by
 * (path, line, ruleId, hash). There is deliberately no inline suppression mechanism; only the
 * base-side `allowlist.testFakes` ({ path, hash: fakeHash(value) }) can exempt a diff location.
 * Optional `salt` (string/Buffer >= 8 bytes) makes the keyed hash reproducible (tests only).
 */
export function scanHygiene({ addedLines = [], paths = [], metadata = {}, denylist, allowlist = {}, deadline, salt } = {}) {
  assertDenylist(denylist);
  const fakes = normalizeAllowlist(allowlist);
  const key = makeSalt(salt);
  const ctx = { denylist, deadline, bytes: 0, decodes: 0 };
  const findings = [];
  const seen = new Set();
  const mac = (ruleId, text) => createHmac('sha256', key).update(`${ruleId}\u0000${text}`).digest('hex').slice(0, 8);
  const scan = (text, opts) => scanText(text, ctx, 0, opts);
  const dirtyPathCache = new Map();

  const shownPath = (raw) => {
    if (!dirtyPathCache.has(raw)) {
      const unsafe = raw.length > 300 || CONTROL_ONLY_RE.test(raw) || /[\u2028\u2029]/.test(raw);
      dirtyPathCache.set(raw, unsafe || scan(raw).length > 0 || scanPathSegments(raw).length > 0 ? `<path:${mac('PATH', raw)}>` : raw);
    }
    return dirtyPathCache.get(raw);
  };
  const scanPathSegments = (p) => {
    const m = [];
    findHomePathSegments(p, m);
    return m;
  };

  const record = (rawPath, display, line, matches, allowFakes) => {
    for (const m of matches) {
      if (allowFakes && fakes.has(`${rawPath}\u0000${fakeHash(m.text)}`)) continue;
      const hash = mac(m.ruleId, m.text.toLowerCase());
      const key2 = `${m.ruleId}|${display}|${line}|${hash}`;
      if (seen.has(key2)) continue;
      seen.add(key2);
      const length = LOW_ENTROPY_RULES.has(m.ruleId) ? 0 : Math.ceil(m.text.length / 16) * 16;
      findings.push({ ruleId: m.ruleId, path: display, line, length, hash });
    }
  };

  const files = new Map();
  for (const entry of Array.isArray(addedLines) ? addedLines : []) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.text !== 'string') {
      throw new HygieneError('INPUT_INVALID', 'gate0: addedLines entry is invalid');
    }
    const line = Number.isInteger(entry.line) ? entry.line : 0;
    const e = { path: entry.path, line, text: entry.text };
    if (!files.has(e.path)) files.set(e.path, []);
    files.get(e.path).push(e);
  }
  for (const [path, entries] of files) {
    const opts = { allowFake: isTestFixturePath(path), codeFile: isCodePath(path) };
    const display = shownPath(path);
    for (const e of [...entries, ...joinedLines(entries)]) {
      // A joined line is exempt only for the numbers its own physical lines are exempt for.
      const versionQuads = new Set((e.versionSrc === undefined ? [e.text] : e.versionSrc).map((t) => versionQuadOf(path, t)).filter(Boolean));
      record(path, display, e.line, scan(e.text, { ...opts, versionQuads }), true);
    }
    for (const e of pemBodyLines(entries)) record(path, display, e.line, [{ ruleId: RULES.CRED, text: 'pem-body:' + e.text }], true);
  }

  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== 'string') throw new HygieneError('INPUT_INVALID', 'gate0: path entry is invalid');
    const matches = scan(p);
    findHomePathSegments(p, matches);
    if (matches.length) record(p, `<path:${mac('PATH', p)}>`, 0, matches, false);
  }

  const meta = metadata || {};
  const scanMulti = (label, text) => {
    if (typeof text !== 'string') return;
    text.split(/\r?\n/).forEach((l, i) => record(label, label, i + 1, scan(l), false));
  };
  const scanSingle = (label, text, relaxedHome = false) => {
    if (typeof text !== 'string') return;
    const matches = scan(text);
    if (relaxedHome) findHomePathSegments(text, matches);
    record(label, label, 0, matches, false);
  };
  (Array.isArray(meta.commitMessages) ? meta.commitMessages : []).forEach((t, i) => scanMulti(`<metadata:commit#${i + 1}>`, t));
  (Array.isArray(meta.authors) ? meta.authors : []).forEach((t, i) => scanSingle(`<metadata:author#${i + 1}>`, t));
  scanSingle('<metadata:prTitle>', meta.prTitle);
  scanMulti('<metadata:prBody>', meta.prBody);
  scanSingle('<metadata:branch>', meta.branch, true);

  // Deterministic order: the per-run hash is the last key and only breaks ties.
  findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.line - b.line || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0) || (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0));
  return findings;
}

const MAX_PRINTED = 200;

function safeField(s, max = 200) {
  let out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0) || /[\p{Cf}\p{Zl}\p{Zp}]/u.test(ch) || cp === 0x5c) {
      out += cp === 0x5c ? '\\\\' : `\\u{${cp.toString(16)}}`;
    } else out += ch;
    if (out.length >= max) return out.slice(0, max) + '...';
  }
  return out;
}

/** Render findings as text using only ruleId / path / line / length / hash (escaped, bounded). */
export function formatFindings(findings) {
  if (!Array.isArray(findings)) return '';
  const lines = findings.slice(0, MAX_PRINTED).map((f) => {
    const rule = /^[A-Z0-9-]+$/.test(String(f.ruleId)) ? String(f.ruleId) : 'HYG-UNKNOWN';
    const hash = /^[0-9a-f]{8}$/.test(String(f.hash)) ? f.hash : '?';
    return `${rule} ${safeField(f.path)}:${Number(f.line) || 0} len=${Number(f.length) || 0} hash=${hash}`;
  });
  if (findings.length > MAX_PRINTED) lines.push(`... ${findings.length - MAX_PRINTED} more findings`);
  return lines.join('\n');
}
