// Safety-sensitive paths: hooks, the gh shim, limits/policy files, the guard, CI workflows and the check script.
const SAFETY = [/^\.githooks\//, /^bin\/gh$/, /(^|\/)(limits|policy)(\/|\.|$)/, /^runtime\/lib\/guard/, /^\.github\/workflows\//, /^scripts\/check\.mjs$/];
// Protocol / config files that define the verdict contract and runtime configuration.
const PROTOCOL = [/(^|\/)config\.env$/, /(^|\/)package\.json$/, /^\.agents\/skills\/roundtable-work\/(templates|prompts)\//, /(^|\/)lib\/(verdict|classify|decide|review-ledger)\.mjs$/];
const LABELS = ['risk:low', 'risk:medium', 'risk:high'];

/** Labels merge risk from diff facts only; pure, never merges and never writes GitHub labels. */
export function mergeRisk({ paths = [], changedLines = 0, ci = '', reviewDisagreement = false }) {
  const unique = [...new Set(paths)];
  const safety = unique.filter(path => SAFETY.some(pattern => pattern.test(path))).sort();
  const protocol = unique.filter(path => PROTOCOL.some(pattern => pattern.test(path))).sort();
  const reasons = [];
  let level = 0;
  if (safety.length) {
    level = 2;
    reasons.push(...safety.map(path => `safety-file:${path}`));
  }
  if (reviewDisagreement) {
    level = 2;
    reasons.push('review-disagreement');
  }
  if (changedLines > 400) {
    level = Math.max(level, 1);
    reasons.push('large-diff');
  }
  if (protocol.length) {
    level = Math.max(level, 1);
    reasons.push(...protocol.map(path => `protocol-file:${path}`));
  }
  if (ci !== 'green') {
    level = Math.min(level + 1, 2);
    reasons.push('ci-not-green');
  }
  return { label: LABELS[level], reasons };
}
