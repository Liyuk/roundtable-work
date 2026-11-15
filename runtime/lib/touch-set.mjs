/**
 * `## Touch set` parsing and path overlap for the scheduler. Pure: no filesystem or network access.
 * Issue bodies are untrusted, so absolute and `..` paths are rejected.
 */

/** Normalized path list from the `## Touch set` section, or null when missing or unparseable. */
export function parseTouchSet(body = '') {
  const lines = String(body).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## Touch set');
  if (start < 0) return null;
  const paths = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    if (!line.trim()) continue;
    const bullet = /^- (.+)$/.exec(line.trim());
    if (!bullet) return null;
    const segments = bullet[1].trim().split('/');
    if (segments[0] === '' || segments.includes('..')) return null;
    const path = segments.filter((segment) => segment && segment !== '.').join('/');
    if (!path) return null;
    paths.push(path);
  }
  return paths.length ? [...new Set(paths)] : null;
}

/** Two paths overlap when they are equal or one is a directory prefix of the other (segment-aware). */
export function overlaps(a, b) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Cross-process lock keys: each path plus every ancestor directory. Overlapping paths always share a key. */
export function lockKeysOf(paths) {
  const keys = new Set();
  for (const path of paths) {
    const segments = path.split('/');
    for (let i = 1; i <= segments.length; i++) keys.add(segments.slice(0, i).join('/'));
  }
  return [...keys].sort();
}
