// Pre-revert dangling-import check. Pure: no fs, no network, no clock; file contents come only from the `files` argument.
// Exports:
//   findDanglingImports({ deleted, files }) -> [{ file, specifier, target }]
//     deleted: repo-relative paths a revert removes
//     files:   Map(repo-relative path -> post-revert content) of the remaining repository
//     Reports each relative ESM import (`from './x.mjs'`, `import './x.mjs'`, `import('./x.mjs')`) in a remaining
//     .mjs file whose resolved target is a deleted path. Bare specifiers and non-.mjs files are ignored.
import { posix } from 'node:path';

const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;

export function findDanglingImports({ deleted, files }) {
  const gone = new Set(deleted);
  const dangling = [];
  for (const [file, content] of files) {
    if (!file.endsWith('.mjs') || gone.has(file)) continue;
    for (const [, specifier] of content.matchAll(RELATIVE_IMPORT)) {
      const target = posix.join(posix.dirname(file), specifier);
      if (gone.has(target)) dangling.push({ file, specifier, target });
    }
  }
  return dangling;
}
