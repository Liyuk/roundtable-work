import { createHash } from 'node:crypto';

// Gate 0 deterministic diff policy over a pinned Git change set. Pure: the caller supplies the
// raw `git diff --raw -z` bytes, the referenced blob contents and the trusted issue policy, so
// this module never shells out, reads the filesystem or talks to the network.
//
// Machine words are built from numeric code points, and CJK classes from Unicode script
// properties, so this source contains no literal Han/kana/hangul text.

const chars = (...codes) => String.fromCodePoint(...codes);
const ZH = {
  LABEL: chars(0x5ba1, 0x67e5, 0x7ed3, 0x8bba),
  PASS: chars(0x901a, 0x8fc7),
  REJECT: chars(0x6253, 0x56de),
  BLOCK: chars(0x963b, 0x585e),
  COMPLETE: chars(0x5b8c, 0x6210),
  PARTIAL: chars(0x90e8, 0x5206, 0x5b8c, 0x6210),
  FAILED: chars(0x5931, 0x8d25),
  UNKNOWN: chars(0x672a, 0x77e5),
  EXECUTED: chars(0x5df2, 0x6267, 0x884c),
  READ: chars(0x5df2, 0x8bfb, 0x53d6),
  SELF: chars(0x81ea, 0x8ff0),
  NOT_RUN: chars(0x672a, 0x8fd0, 0x884c),
};

const TICKET_STATUSES = [
  'queued', 'assigned', 'working', 'review', 'ready', 'done',
  'waiting_external', 'waiting_person', 'blocked', 'failed', 'cancelled', 'unknown',
];
const DELEGATION_EVENTS = ['sent', 'delivered', 'acknowledged', 'started', 'returned'];
const CONTINUATION = ['continue', 'wait', 'ask', 'done', 'stop'];
const VERDICT_ALIASES = ['passed', 'rejected', 'blocked', 'returned'];
const BUILTIN_TOKENS = [
  ...TICKET_STATUSES, ...DELEGATION_EVENTS, ...CONTINUATION, ...VERDICT_ALIASES,
  ZH.COMPLETE, ZH.PARTIAL, ZH.FAILED, ZH.BLOCK, ZH.UNKNOWN,
  ZH.EXECUTED, ZH.READ, ZH.SELF, ZH.NOT_RUN,
  ZH.LABEL, ZH.PASS, ZH.REJECT,
];

const CJK_SOURCE = '\\p{Script=Han}|\\p{Script=Hiragana}|\\p{Script=Katakana}|\\p{Script=Hangul}|\\p{Script=Bopomofo}';
const CJK_ALL = new RegExp(CJK_SOURCE, 'gu');
const CJK_ONE = new RegExp(CJK_SOURCE, 'u');
const hasCjk = (text) => CJK_ONE.test(String(text));
const cjkCount = (text) => (String(text).match(CJK_ALL) || []).length;

const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const UTF8 = new TextDecoder('utf-8', { fatal: true });
function decode(buf) {
  try { return UTF8.decode(buf); } catch { return undefined; }
}
const isBinary = (buf) => buf.includes(0) || decode(buf) === undefined;

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const commitLength = (value) => (typeof value === 'string' && COMMIT_ID.test(value) ? value.length : 0);

// --- paths and globs -------------------------------------------------------

function unsafePath(path) {
  if (typeof path !== 'string' || path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return true;
  if (path.includes('\\') || /[\u0000-\u001f\u007f-\u009f]/.test(path)) return true;
  return path.split('/').some((seg) => seg === '' || seg === '.' || seg === '..'
    || /^\.git(?:$|[.~ ])/i.test(seg) || /[. ]$/.test(seg));
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += escapeRe(c);
  }
  return new RegExp(`^${out}$`);
}

const matchesAny = (path, globs) => globs.some((glob) => globToRegExp(glob).test(path));

const validGlobs = (globs) => Array.isArray(globs) && globs.length > 0
  && globs.every((glob) => typeof glob === 'string' && glob !== '' && !glob.startsWith('/') && !glob.split('/').includes('..'));

// --- Git raw evidence ------------------------------------------------------

/**
 * `git diff --raw -z --no-abbrev --find-renames --find-copies --find-copies-harder` records:
 * `:oldmode newmode oldoid newoid status\0path\0`, with `oldpath\0newpath\0` for R/C.
 * Strict: the stream ends with NUL and every token of every record must be present.
 */
function parseEvidence(bytes, idLen) {
  const records = [];
  const errors = [];
  const bad = (detail) => errors.push({ rule: 'evidence', path: '<diff>', detail });
  if (bytes.length === 0) return { records, errors };
  if (bytes[bytes.length - 1] !== 0) { bad('evidence does not end with NUL (truncated)'); return { records, errors }; }
  const parts = bytes.toString('latin1').split('\0');
  parts.pop();
  const zero = '0'.repeat(idLen);
  const fullOid = new RegExp(`^[0-9a-f]{${idLen}}$`);
  for (let i = 0; i < parts.length;) {
    const header = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([AMDTCR])([0-9]{0,3})$/.exec(parts[i]);
    if (!header) { bad(`malformed record header: ${JSON.stringify(parts[i].slice(0, 60))}`); break; }
    const [, oldMode, newMode, oldOid, newOid, status] = header;
    const pathCount = status === 'R' || status === 'C' ? 2 : 1;
    if (i + pathCount > parts.length - 1) { bad('truncated record (missing path token)'); break; }
    const path = decode(Buffer.from(parts[i + 1], 'latin1'));
    const oldPath = pathCount === 2 ? decode(Buffer.from(parts[i + 2], 'latin1')) : undefined;
    if (!path || (pathCount === 2 && !oldPath)) { bad('missing or invalid UTF-8 path'); break; }
    if (!fullOid.test(oldOid)) bad(`old object id is not a full ${idLen}-digit id: ${oldOid}`);
    if (!fullOid.test(newOid)) bad(`new object id is not a full ${idLen}-digit id: ${newOid}`);
    if (status === 'A' && oldOid !== zero) bad('A record has a non-zero old object id');
    if (status === 'D' && newOid !== zero) bad('D record has a non-zero new object id');
    if (status !== 'A' && status !== 'D' && (oldOid === zero || newOid === zero)) bad(`${status} record has a zero object id`);
    records.push({ oldMode, newMode, oldOid, newOid, status, path, oldPath });
    i += pathCount + 1;
  }
  return { records, errors };
}

const foldPath = (path) => path.normalize('NFC').toLowerCase();

// --- frozen machine contracts ---------------------------------------------

const paren = (token) => `${escapeRe(token)}(?:[ \\t]*\\([^()\\n]*\\))?`;
const VERDICT_CORE = `${escapeRe(ZH.LABEL)}[:\\uff1a][ \\t]*${paren(ZH.PASS)}[ \\t]*\\|[ \\t]*${paren(ZH.REJECT)}[ \\t]*\\|[ \\t]*${paren(ZH.BLOCK)}`;
// Anchored whole line: optional list marker and backticks, optional English parentheticals; or a
// backticked span anywhere in a prose line, as the repository templates write it.
const VERDICT_LINE = new RegExp(`^[ \\t]*(?:[-*>][ \\t]+)?\`?${VERDICT_CORE}\`?[ \\t]*$|\`${VERDICT_CORE}\``);
const squash = (text) => String(text).replace(/\s*\([^()\n]*\)/g, '').replace(/[ \t]+/g, ' ').trim();

const PLACEHOLDER = /(?<![\p{L}\p{N}_])<([\p{L}\p{N}](?:[^<>=/@\n"'`]{0,38}[\p{L}\p{N}])?)>/gu;

function placeholders(text) {
  const out = new Set();
  for (const m of String(text).matchAll(PLACEHOLDER)) {
    if (m[1].trim().split(/\s+/).length > 4) continue;
    out.add(m[0]);
  }
  return [...out];
}

/** Field labels and `<...>` placeholders from base-side templates, plus trusted extras. */
function buildRegistry(templates, extras) {
  const tokens = new Set(BUILTIN_TOKENS);
  for (const template of Array.isArray(templates) ? templates : []) {
    if (!template || typeof template.content !== 'string') continue;
    for (const line of template.content.split('\n')) {
      const label = /^\s*[-*]\s+(.+?):(?:\s|$)/.exec(line.replace(/\r$/, ''));
      if (label) {
        const name = label[1].split(' (')[0].replace(/[`*]/g, '').trim();
        if (name.length >= 2 && name.length <= 80) tokens.add(name);
      }
      for (const placeholder of placeholders(line)) tokens.add(placeholder);
    }
  }
  for (const extra of Array.isArray(extras) ? extras : []) if (typeof extra === 'string' && extra) tokens.add(extra);
  return [...tokens];
}

const wordCache = new Map();
function countToken(text, token) {
  if (hasCjk(token) || !/^\w+$/.test(token)) return String(text).split(token).length - 1;
  let re = wordCache.get(token);
  if (!re) { re = new RegExp(`(?<!\\w)${escapeRe(token)}(?!\\w)`, 'g'); wordCache.set(token, re); }
  return (String(text).match(re) || []).length;
}

function verdictLines(text) {
  const out = [];
  let fence = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1][0]; else if (marker[1][0] === fence) fence = null;
      continue;
    }
    const m = VERDICT_LINE.exec(line);
    if (m) out.push(`${fence === null ? 'prose' : 'fence'}:${squash(m[0])}`);
  }
  return out;
}

function missingFrom(baseList, headList) {
  const counts = new Map();
  for (const item of headList) counts.set(item, (counts.get(item) || 0) + 1);
  return baseList.filter((item) => {
    const count = counts.get(item) || 0;
    if (count === 0) return true;
    counts.set(item, count - 1);
    return false;
  });
}

// --- encoded views and direction ------------------------------------------

const cp = (n) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\ufffd');
const ENTITY = /&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi;
const UNICODE_ESC = /\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})/gi;
const HEX_ESC = /(?:\\x[0-9a-f]{2})+/gi;
const BYTE_ESC = /\\x([0-9a-f]{2})/gi;
const PERCENT = /(?:%[0-9a-f]{2}){2,}/gi;
const BASE64 = /[A-Za-z0-9+/_-]{16,}={0,2}/g;

/** Bounded decode views of a line: HTML numeric references, escapes, percent and base64 runs. */
function decodeViews(text) {
  const views = [];
  if (text.includes('&#')) views.push(text.replace(ENTITY, (_, hex, dec) => cp(hex ? parseInt(hex, 16) : parseInt(dec, 10))));
  if (text.includes('\\')) {
    let view = text.replace(UNICODE_ESC, (_, braced, plain) => cp(parseInt(braced ?? plain, 16)));
    view = view.replace(HEX_ESC, (span) => {
      const bytes = [...span.matchAll(BYTE_ESC)].map((m) => parseInt(m[1], 16));
      return decode(Buffer.from(bytes)) ?? span;
    });
    if (view !== text) views.push(view);
  }
  if (text.includes('%')) views.push(text.replace(PERCENT, (span) => { try { return decodeURIComponent(span); } catch { return span; } }));
  let seen = 0;
  for (const m of text.matchAll(BASE64)) {
    if (++seen > 50) break;
    for (const cut of [0, 1, 2]) {
      const raw = m[0].slice(cut).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = decode(Buffer.from(raw, 'base64'));
      if (decoded !== undefined && decoded.length >= 4) views.push(decoded);
    }
  }
  return views;
}

function views(text) {
  const out = [text];
  const normalized = text.normalize('NFKC');
  if (normalized !== text) out.push(normalized);
  for (const view of decodeViews(text)) {
    out.push(view);
    const n = view.normalize('NFKC');
    if (n !== view) out.push(n);
  }
  return out;
}

/** Frozen CJK tokens are preserved contract text, not new Chinese prose. */
function stripFrozen(line, frozen) {
  let out = line;
  for (const token of frozen) out = out.split(token).join(' ');
  return out;
}

/** Greatest CJK count over the raw and decoded views of one line (encoded CJK counts too). */
function lineCjk(line, frozen) {
  let max = 0;
  for (const view of views(stripFrozen(line, frozen))) max = Math.max(max, cjkCount(view));
  return max;
}

function lineHasCjk(line, frozen) {
  return views(stripFrozen(line, frozen)).some(hasCjk);
}

/** Multiset line difference: a line that only moved is neither added nor removed. */
function lineDiff(baseText, headText) {
  const baseLines = baseText.split('\n');
  const headLines = headText.split('\n');
  const headCounts = new Map();
  for (const line of headLines) headCounts.set(line, (headCounts.get(line) || 0) + 1);
  const removed = baseLines.filter((line) => {
    const count = headCounts.get(line) || 0;
    if (count === 0) return true;
    headCounts.set(line, count - 1);
    return false;
  });
  const baseCounts = new Map();
  for (const line of baseLines) baseCounts.set(line, (baseCounts.get(line) || 0) + 1);
  const added = headLines.filter((line) => {
    const count = baseCounts.get(line) || 0;
    if (count === 0) return true;
    baseCounts.set(line, count - 1);
    return false;
  });
  return { added, removed };
}

const MARKER = /\.(?:skip|only)\b|\btodo\b|\bxit\b|\b(?:skip|only)\s*:|\{\s*(?:skip|only)\b/i;

// --- policy ---------------------------------------------------------------

export function validateDiffPolicy({ base, head, evidence, blobs, allowedPaths, allow = {}, baseline = {} } = {}) {
  const errors = [];
  const add = (rule, path, detail) => errors.push({ rule, path, detail });
  const idLen = commitLength(base);
  if (idLen === 0 || commitLength(head) !== idLen) {
    add('id', '<commit>', 'base and head must be full lowercase commit object ids of the same length');
    return { passed: false, errors };
  }
  if (!validGlobs(allowedPaths)) {
    add('scope', '<allowedPaths>', 'allowedPaths must be a non-empty list of trusted path globs');
    return { passed: false, errors };
  }
  const bytes = Buffer.isBuffer(evidence) ? evidence
    : typeof evidence === 'string' ? Buffer.from(evidence, 'utf8') : undefined;
  if (!bytes) {
    add('evidence', '<diff>', 'evidence must be the raw bytes of `git diff --raw -z`');
    return { passed: false, errors };
  }
  const parsed = parseEvidence(bytes, idLen);
  if (parsed.errors.length) return { passed: false, errors: [...errors, ...parsed.errors] };

  const policy = baseline ?? {};
  const flags = allow ?? {};
  const cjkPaths = policy.cjkPathAllowlist ?? [];
  const markerAllowlist = policy.markerAllowlist ?? [];
  const tokens = buildRegistry(policy.templates, policy.frozenTokens);
  const tokenSet = new Set(tokens);
  const frozenCjk = tokens.filter(hasCjk);
  const zero = '0'.repeat(idLen);
  const hashName = idLen === 64 ? 'sha256' : 'sha1';

  const seenPaths = new Map();
  for (const record of parsed.records) {
    for (const path of [record.path, record.oldPath].filter(Boolean)) {
      const fold = foldPath(path);
      if (seenPaths.has(fold)) add('evidence', path, seenPaths.get(fold) === path ? 'duplicate changed path' : 'case-fold colliding changed path');
      else seenPaths.set(fold, path);
    }
  }

  const blobCache = new Map();
  function blobOf(oid) {
    if (blobCache.has(oid)) return blobCache.get(oid);
    const value = blobs instanceof Map ? blobs.get(oid) : (blobs && typeof blobs === 'object' ? blobs[oid] : undefined);
    let buf;
    if (typeof value === 'string') buf = Buffer.from(value, 'utf8');
    else if (Buffer.isBuffer(value)) buf = value;
    if (!buf) { add('blob', oid, 'missing blob content'); return undefined; }
    const hash = createHash(hashName).update(`blob ${buf.length}\0`).update(buf).digest('hex');
    if (hash !== oid) { add('blob', oid, 'blob content does not hash to its object id'); return undefined; }
    blobCache.set(oid, buf);
    return buf;
  }

  for (const record of parsed.records) {
    const { status, oldMode, newMode, oldOid, newOid } = record;
    for (const path of [record.path, record.oldPath].filter(Boolean)) {
      if (unsafePath(path)) add('scope', path, 'unsafe changed path');
      else if (!matchesAny(path, allowedPaths)) add('scope', path, 'changed path outside the allowed scope');
    }
    if (status === 'D' && flags.deletions !== true) add('scope', record.path, 'deletion is not authorized');
    if (status === 'R' && flags.renames !== true) add('scope', record.path, 'rename is not authorized');
    if (status === 'C' && flags.copies !== true) add('scope', record.path, 'copy is not authorized');

    const gitlink = oldMode === '160000' || newMode === '160000';
    const link = oldMode === '120000' || newMode === '120000';
    if (gitlink && flags.submodules !== true) add('special', record.path, 'submodule is not authorized');
    if (link && flags.symlinks !== true) add('special', record.path, 'symlink is not authorized');
    if (oldMode !== newMode && oldMode !== '000000' && newMode !== '000000' && flags.modeChanges !== true) {
      add('special', record.path, 'mode change is not authorized');
    }
    if (!['000000', '100644', '100755', '120000', '160000'].includes(oldMode)
      || !['000000', '100644', '100755', '120000', '160000'].includes(newMode)) {
      add('special', record.path, 'unsupported file mode');
    }
    if (gitlink) continue;
    const oldBuf = oldOid === zero ? Buffer.alloc(0) : blobOf(oldOid);
    const newBuf = newOid === zero ? Buffer.alloc(0) : blobOf(newOid);
    if (!oldBuf || !newBuf) continue;
    if (status === 'D' || link) continue;
    if (isBinary(oldBuf) || isBinary(newBuf)) {
      if (flags.binaries !== true) add('special', record.path, 'binary content is not authorized');
      continue;
    }

    const baseText = decode(oldBuf);
    const headText = decode(newBuf);
    const { added, removed } = lineDiff(baseText, headText);
    const allowlisted = matchesAny(record.path, cjkPaths);

    for (const line of added) {
      if (!allowlisted && lineHasCjk(line, frozenCjk)) add('direction', record.path, `non-English added line: ${line.slice(0, 80)}`);
      if (MARKER.test(line) && !markerAllowlist.some((marker) => line.includes(marker))) {
        add('marker', record.path, `test-disabling marker in added line: ${line.slice(0, 80)}`);
      }
    }
    const addedCjk = added.reduce((sum, line) => sum + lineCjk(line, frozenCjk), 0);
    const removedCjk = removed.reduce((sum, line) => sum + lineCjk(line, frozenCjk), 0);
    if (addedCjk > removedCjk) add('direction', record.path, `added CJK (${addedCjk}) exceeds removed CJK (${removedCjk})`);

    const fileTokens = placeholders(baseText).filter((token) => !tokenSet.has(token));
    for (const token of [...tokens, ...fileTokens]) {
      const before = countToken(baseText, token);
      if (before > 0 && countToken(headText, token) < before) {
        add('contract', record.path, `frozen token removed or renamed: ${token}`);
      }
    }
    if (missingFrom(verdictLines(baseText), verdictLines(headText)).length > 0) {
      add('contract', record.path, 'verdict template line lost its anchored form (line, fence or inline span)');
    }
    for (const line of added) {
      if (line.includes(ZH.LABEL) && !VERDICT_LINE.test(line)) {
        add('contract', record.path, 'added line carries the verdict label but is not the anchored verdict line');
      }
    }
  }
  return { passed: errors.length === 0, errors };
}
