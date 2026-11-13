import { lstat, realpath, open, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

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
  const rootStat = await lstat(realRoot);
  // A filesystem root would make every path "inside" (and `root + sep` is `//`): refuse it up front.
  for (const root of [lexicalRoot, realRoot]) {
    if (root === parse(root).root) throw new TypeError(`workRoot must not be a filesystem root: ${root}`);
  }

  async function resolveInside(...parts) {
    for (const part of parts) {
      if (typeof part !== 'string' || part === '' || part.includes('\0')) throw new PathEscapeError(`Invalid path segment: ${JSON.stringify(part)}`);
    }
    const lexical = parts.length === 1 && isAbsolute(parts[0]) ? resolve(parts[0]) : resolve(lexicalRoot, ...parts);
    if (!within(lexicalRoot, lexical)) throw new PathEscapeError(`Path escapes the work root: ${parts.join('/')}`);

    // Resolve symlinks on the deepest existing ancestor, then re-attach the missing tail.
    let current = lexical;
    const tail = [];
    let retries = 0;
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
        const entry = await lstat(current);
        if (entry.isSymbolicLink()) throw new PathEscapeError(`Dangling symlink under the work root: ${parts.join('/')}`);
        if (++retries > 8) throw new PathEscapeError(`Unable to resolve unstable path under the work root: ${parts.join('/')}`);
        continue;
      } catch (err) {
        if (err instanceof PathEscapeError) throw err;
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      }
      const parent = resolve(current, '..');
      if (parent === current) throw new PathEscapeError(`No existing ancestor for: ${parts.join('/')}`);
      retries = 0;
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }

  // Linux supports fd-relative pathname traversal through procfs. Node has no
  // openat or F_GETPATH binding on Darwin: its fallback verifies the pinned
  // directory against its real pathname before and after each operation. This
  // detects replacement but cannot prevent a transient pathname swap during an
  // operation; a native fd-relative primitive is needed to close that race.
  async function withParent(path, fn, { create = false, fs = { mkdir } } = {}) {
    const lexical = await this.resolve(path);
    const components = relative(lexicalRoot, dirname(lexical)).split(sep).filter(Boolean);
    const handles = [];
    try {
      const rootHandle = await open(realRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(rootHandle);
      const stat = await rootHandle.stat();
      if (stat.dev !== rootStat.dev || stat.ino !== rootStat.ino) throw new PathEscapeError('Work root changed');
      let parentPath = realRoot;
      const verifyParent = async (handle, path) => {
        const [pinned, actual] = await Promise.all([handle.stat(), lstat(path)]);
        if (!actual.isDirectory() || pinned.dev !== actual.dev || pinned.ino !== actual.ino) {
          throw new PathEscapeError('Pinned parent changed');
        }
      };
      const linux = process.platform === 'linux';
      for (const component of components) {
        const parent = handles.at(-1);
        if (!linux) await verifyParent(parent, parentPath);
        const anchor = linux ? `/proc/self/fd/${parent.fd}` : parentPath;
        const next = `${anchor}/${component}`;
        if (create) {
          try { await fs.mkdir(next); }
          catch (err) { if (err.code !== 'EEXIST') throw err; }
        }
        if (!linux) await verifyParent(parent, parentPath);
        try { handles.push(await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)); }
        catch (err) {
          if (err.code === 'ELOOP' || err.code === 'ENOTDIR') throw new PathEscapeError('Symlink or non-directory in confined path');
          throw err;
        }
        if (!linux) {
          await verifyParent(parent, parentPath);
          parentPath = await realpath(next);
          if (!within(realRoot, parentPath)) throw new PathEscapeError('Parent escaped work root');
          await verifyParent(handles.at(-1), parentPath);
        }
      }
      const parent = handles.at(-1);
      if (!linux) await verifyParent(parent, parentPath);
      try {
        return await fn(linux ? `/proc/self/fd/${parent.fd}` : parentPath, basename(lexical));
      } finally {
        if (!linux) await verifyParent(parent, parentPath);
      }
    } finally {
      for (const handle of handles.reverse()) await handle.close();
    }
  }

  return { root: lexicalRoot, realRoot, resolve: resolveInside, withParent };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Issue ids become file names, so only a conservative character set is allowed. */
export function assertSafeId(id) {
  const text = String(id);
  if (!SAFE_ID.test(text) || text.includes('..')) throw new PathEscapeError(`Unsafe id: ${JSON.stringify(text)}`);
  return text;
}
