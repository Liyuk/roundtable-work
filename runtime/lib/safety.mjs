/**
 * Safety-file classification shared by the gate runner and the merge entry point.
 *
 * The gate runner derives the safety set from the gated diff and persists it; the merge entry point
 * derives it again from the live pull request's changed files. Both sides must use this module so the
 * definitions cannot drift.
 */

/** Files whose change requires recorded escalation-model approval before auto-merge. */
export const SAFETY_FILE = /^(?:\.githooks\/|.*(?:^|\/)(?:pre-push|limits|policy)(?:\.|$)|bin\/gh$|runtime\/lib\/guard[^/]*|\.github\/workflows\/|scripts\/check\.mjs$)/i;

/** De-duplicated, sorted safety-file paths from a list of changed paths. */
export function safetyFiles(paths) {
  if (!Array.isArray(paths)) throw new TypeError('Changed file paths must be an array');
  return [...new Set(paths.filter((path) => typeof path === 'string' && SAFETY_FILE.test(path)))].sort();
}
