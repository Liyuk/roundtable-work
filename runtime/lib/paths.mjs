import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathEscapeError';
    this.code = 'RT_PATH_ESCAPE';
  }
}

const within = (root, path) => path === root || path.startsWith(root + sep);

/**
 * Create a resolver that confines every path to `workRoot`.
 * Rejects `..` escapes, absolute paths outside the root, symlink escapes
 * (checked with realpath on the deepest existing ancestor) and dangling symlinks.
 * The work root itself must already exist.
 */
export async function createConfinement(workRoot) {
  if (typeof workRoot !== 'string' || workRoot === '') throw new TypeError('workRoot must be a non-empty string');
  const lexicalRoot = resolve(workRoot);
  const realRoot = await realpath(lexicalRoot);

  async function resolveInside(...parts) {
    for (const part of parts) {
      if (typeof part !== 'string' || part === '' || part.includes('\0')) throw new PathEscapeError(`Invalid path segment: ${JSON.stringify(part)}`);
    }
    const lexical = parts.length === 1 && isAbsolute(parts[0]) ? resolve(parts[0]) : resolve(lexicalRoot, ...parts);
    if (!within(lexicalRoot, lexical)) throw new PathEscapeError(`Path escapes the work root: ${parts.join('/')}`);

    // Resolve symlinks on the deepest existing ancestor, then re-attach the missing tail.
    let current = lexical;
    const tail = [];
    for (;;) {
      try {
        const real = await realpath(current);
        const full = resolve(real, ...tail.reverse());
        if (!within(realRoot, full)) throw new PathEscapeError(`Symlink escapes the work root: ${parts.join('/')}`);
        return lexical;
      } catch (err) {
        if (err instanceof PathEscapeError) throw err;
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      }
      try {
        await lstat(current);
        throw new PathEscapeError(`Dangling symlink under the work root: ${parts.join('/')}`);
      } catch (err) {
        if (err instanceof PathEscapeError) throw err;
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      }
      const parent = resolve(current, '..');
      if (parent === current) throw new PathEscapeError(`No existing ancestor for: ${parts.join('/')}`);
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }

  return { root: lexicalRoot, realRoot, resolve: resolveInside };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Issue ids become file names, so only a conservative character set is allowed. */
export function assertSafeId(id) {
  const text = String(id);
  if (!SAFE_ID.test(text) || text.includes('..')) throw new PathEscapeError(`Unsafe id: ${JSON.stringify(text)}`);
  return text;
}
