import { lstat, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

export class ReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseError';
    this.code = 'RT_RELEASE_FAILED';
  }
}

const fail = (reason) => { throw new ReleaseError(`${reason}; no work started`); };
const SHA = /^[0-9a-f]{7,40}$/;

/** Resolve `<baseDir>/current` to `releases/<sha>`, failing closed. */
export async function resolveCurrentRelease(baseDir) {
  if (typeof baseDir !== 'string' || baseDir === '') throw new TypeError('baseDir must be a non-empty string');
  const base = resolve(baseDir);
  const current = join(base, 'current');
  const link = await lstat(current).catch(() => null);
  if (!link?.isSymbolicLink()) fail('current is missing or not a symlink');
  const target = await realpath(current).catch(() => fail('current is dangling or unknown release'));
  const releases = await realpath(join(base, 'releases')).catch(() => fail('releases directory is missing'));
  const sha = relative(releases, target);
  if (!SHA.test(sha)) fail('current points outside releases or names a malformed sha');
  if (!(await stat(target)).isDirectory()) fail('current release is not a directory');
  return { sha, path: target };
}
