import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// True when the module at `moduleUrl` is the script node was asked to run.
//
// Node resolves symbolic links for the main module, so `import.meta.url` is the real path,
// while `process.argv[1]` keeps the path the caller used (for example a /tmp path that is a
// symlink to another directory). Comparing the two directly, or with path.resolve, then
// silently skips main(). Compare the real paths of both sides instead. A module that is only
// imported (tests, other scripts) still gets false, because argv[1] names a different file.
export function isEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const real = (path) => { try { return realpathSync(path); } catch { return null; } };
  const self = real(fileURLToPath(moduleUrl));
  return self !== null && self === real(argv1);
}
