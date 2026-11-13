import { createHash } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

const PRIVATE_HOST_SUFFIXES = ['.internal', '.local', '.lan', '.home'];
const COMMON_HOST_SUFFIX = /^\.(?:local|lan|internal|home)(?![a-z0-9-])/;
const COMMON_HOST_PREFIX = /(?:@|\/\/)$/;
const SSH_TARGET = /\b(?:ssh|scp)\s+(?:-\S+\s+)*(?:\S+\s+)?$/;
const NAME_EDGE = /[a-z0-9_-]/;
const CREDENTIAL_KEY = /(?:^|[\s"'`;,])(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)(?:\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/ig;
const CREDENTIAL_FORMS = /(?:\b(?:gh[pousr]_|github_pat_|sk_live_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{8,}|-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@)/gi;
const HOME_PATH = new RegExp('(?:^|[\\s=:"\'])(?:' + [
  '/(?:home|Users|root)/[^/\\s<][^/\\s]*',
  '~/[^\\s]+',
  '~[\\w.-]+/',
  '[A-Za-z]:\\\\Users\\\\[^\\\\\\s<][^\\\\\\s]*',
].join('|') + ')', 'gi');
const IPV6 = /(?<![\w:])(?:[a-f\d]{0,4}:){2,7}[a-f\d]{0,4}(?![\w:])/gi;
const IPV4 = /(?<![\w.@])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;

export class HygieneConfigError extends Error {
  constructor() {
    super('Hygiene scanner configuration is invalid');
    this.name = 'HygieneConfigError';
    this.code = 'RT_HYGIENE_CONFIG';
  }
}

const failClosed = () => { throw new HygieneConfigError(); };
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`);

function ipv4Kind(address) {
  const octets = address.split('.').map(Number);
  if (octets.some((n) => n > 255)) return null;
  const [a, b] = octets;
  if (a === 127 || (a === 192 && b === 0 && octets[2] === 2) || (a === 198 && b === 51 && octets[2] === 100) || (a === 203 && b === 0 && octets[2] === 113)) return 'allowed';
  if (a === 10 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private-ip';
  return 'public-ip';
}

function ipv6Kind(address) {
  let normalized;
  try { normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1); } catch { return null; }
  if (normalized.startsWith('::ffff:')) {
    const parts = normalized.slice(7).split(':').map((part) => parseInt(part, 16));
    return ipv4Kind([parts[0] >> 8, parts[0] & 255, parts[1] >> 8, parts[1] & 255].join('.'));
  }
  if (normalized === '::1' || normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return 'allowed';
  const first = parseInt(normalized.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || normalized === '::' ? 'private-ip' : 'public-ip';
}

function decodeLayers(text) {
  const variants = [text];
  const decoded = text.replace(/\+/g, ' ').replace(/(?:%[0-9a-f]{2})+/gi, (bytes) => Buffer.from(bytes.replace(/%/g, ''), 'hex').toString('utf8'));
  if (decoded !== text) variants.push(decoded);
  const candidates = [...variants];
  for (const value of candidates) {
    for (const token of value.match(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9+/=])/g) ?? []) {
      if (token.length % 4 === 1) continue;
      try {
        const decoded = Buffer.from(token, 'base64').toString('utf8');
        if (decoded && !decoded.includes('\uFFFD')) variants.push(decoded);
      } catch { /* ignore invalid candidates */ }
    }
  }
  return variants;
}

function binaryText(value) {
  if (typeof value === 'string') return value;
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) return '';
  const bytes = Buffer.from(value);
  // Keep printable ASCII and common whitespace. This detects strings embedded in binary
  // payloads without copying binary data into diagnostics.
  return bytes.toString('latin1').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, ' ');
}

async function trustedDenylist({ denylistPath, repoRoot, expectedSha256 }) {
  try {
    if (typeof denylistPath !== 'string' || !isAbsolute(denylistPath) || typeof repoRoot !== 'string' || !isAbsolute(repoRoot) || !/^[a-f\d]{64}$/i.test(expectedSha256)) failClosed();
    const [realDenylist, realRepo] = await Promise.all([realpath(denylistPath), realpath(repoRoot)]);
    if (within(realRepo, realDenylist)) failClosed();
    const info = await lstat(denylistPath);
    if (!info.isFile() || info.isSymbolicLink()) failClosed();
    const bytes = await readFile(denylistPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expectedSha256.toLowerCase()) failClosed();
    const names = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(names)) failClosed();
    const entries = new Map();
    for (const item of names) {
      const name = typeof item === 'string' ? item : item?.common === true ? item.name : null;
      if (typeof name !== 'string' || !name || name.length > 253) failClosed();
      entries.set(name.toLowerCase(), typeof item !== 'string');
    }
    return [...entries].map(([name, common]) => ({ name, common }));
  } catch {
    failClosed();
  }
}

/**
 * Scan submitted repository text, paths, and metadata using a pinned denylist stored
 * outside the repository. A missing or untrusted configuration always fails closed.
 */
export async function scanHygiene({ entries, denylistPath, repoRoot, expectedSha256 } = {}) {
  if (!Array.isArray(entries)) throw new TypeError('Hygiene entries must be an array');
  const denylist = await trustedDenylist({ denylistPath, repoRoot, expectedSha256 });
  const findings = [];
  for (const [index, entry] of entries.entries()) {
    const label = `entry-${index}`;
    const text = binaryText(entry?.value);
    const seen = new Set();
    for (const variant of decodeLayers(text)) {
      const emit = (kind, offset) => {
        const key = `${kind}:${offset}`;
        if (!seen.has(key)) { seen.add(key); findings.push({ source: label, kind, offset }); }
      };
      for (const match of variant.matchAll(IPV4)) {
        const kind = ipv4Kind(match[0]);
        if (kind && kind !== 'allowed') emit(kind, match.index);
      }
      for (const match of variant.matchAll(IPV6)) {
        const kind = ipv6Kind(match[0]);
        if (kind && kind !== 'allowed') emit(kind, match.index);
      }
      for (const match of variant.matchAll(CREDENTIAL_FORMS)) emit('credential', match.index);
      for (const match of variant.matchAll(HOME_PATH)) emit('home-path', match.index);
      CREDENTIAL_KEY.lastIndex = 0;
      for (const match of variant.matchAll(CREDENTIAL_KEY)) emit('credential', match.index);
      const lower = variant.toLowerCase();
      for (const suffix of PRIVATE_HOST_SUFFIXES) {
        const pattern = new RegExp(`(?<![a-z0-9-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?${suffix.replace('.', '\\.')}\\b`, 'g');
        for (const match of lower.matchAll(pattern)) emit('private-hostname', match.index);
      }
      for (const { name, common } of denylist) {
        let from = 0;
        while ((from = lower.indexOf(name, from)) !== -1) {
          const before = lower.slice(0, from);
          const after = lower.slice(from + name.length);
          const bounded = (!before || !NAME_EDGE.test(before.at(-1))) && (!after[0] || !NAME_EDGE.test(after[0]));
          const hostContext = COMMON_HOST_PREFIX.test(before) || SSH_TARGET.test(before) || COMMON_HOST_SUFFIX.test(after);
          if (common ? hostContext : bounded) emit('denylisted-name', from);
          from += Math.max(1, name.length);
        }
      }
    }
  }
  return findings.sort((a, b) => a.source.localeCompare(b.source) || a.offset - b.offset || a.kind.localeCompare(b.kind));
}
