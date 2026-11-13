import { createHash } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

const PRIVATE_HOST_SUFFIXES = ['.internal', '.local', '.lan', '.corp', '.home'];
const CREDENTIAL_KEY = /(?:^|[\s"'`;,])(?:password|passwd|token|secret|api[_-]?key|access[_-]?key|client[_-]?secret)(?:\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/ig;
const HOME_PATH = new RegExp("(?:^|[\\s=:\"'])(?:" + ['/', 'home/'].join('') + "[^/\\s]+|" + ['/', 'Users/'].join('') + "[^/\\s]+|~/[^\\s]+)", 'gi');
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;

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
  if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private-ip';
  return 'public-ip';
}

function decodeLayers(text) {
  const variants = [text];
  try {
    const decoded = decodeURIComponent(text.replace(/\+/g, '%20'));
    if (decoded !== text) variants.push(decoded);
  } catch { /* malformed percent encoding is not a scanner error */ }
  const candidates = [...variants];
  for (const value of candidates) {
    for (const token of value.match(/[A-Za-z0-9+/]{20,}={0,2}/g) ?? []) {
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
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !name || name.length > 253)) failClosed();
    return [...new Set(names.map((name) => name.toLowerCase()))];
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
    const label = typeof entry?.source === 'string' && /^[A-Za-z0-9._/-]{1,120}$/.test(entry.source) ? entry.source : `entry-${index}`;
    const text = binaryText(entry?.value);
    const seen = new Set();
    for (const variant of decodeLayers(text)) {
      const emit = (kind, offset) => {
        const key = `${kind}:${offset}`;
        if (!seen.has(key)) { seen.add(key); findings.push({ source: label, kind, offset }); }
      };
      for (const match of variant.matchAll(IPV4)) {
        const kind = ipv4Kind(match[0]);
        if (kind === 'private-ip') emit(kind, match.index);
      }
      for (const match of variant.matchAll(HOME_PATH)) emit('home-path', match.index);
      CREDENTIAL_KEY.lastIndex = 0;
      for (const match of variant.matchAll(CREDENTIAL_KEY)) emit('credential', match.index);
      const lower = variant.toLowerCase();
      for (const suffix of PRIVATE_HOST_SUFFIXES) {
        const pattern = new RegExp(`(?<![a-z0-9-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?${suffix.replace('.', '\\.')}\\b`, 'g');
        for (const match of lower.matchAll(pattern)) emit('private-hostname', match.index);
      }
      for (const name of denylist) {
        let from = 0;
        while ((from = lower.indexOf(name, from)) !== -1) {
          const before = lower[from - 1];
          const after = lower[from + name.length];
          if ((!before || !/[a-z0-9._-]/.test(before)) && (!after || !/[a-z0-9._-]/.test(after))) emit('denylisted-name', from);
          from += Math.max(1, name.length);
        }
      }
    }
  }
  return findings.sort((a, b) => a.source.localeCompare(b.source) || a.offset - b.offset || a.kind.localeCompare(b.kind));
}
