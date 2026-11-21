// Semver-style range check (engines syntax): `>=`, `<=`, `>`, `<`, `^`, `~`, `=`, bare or x-range parts.
const parseVersion = (text) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text));
  return match ? match.slice(1).map(Number) : null;
};
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** True when `runtime` satisfies the base `engines` range (no range or a foreign syntax is a reject). */
export function satisfies(range, runtime) {
  const version = parseVersion(runtime);
  if (!version || typeof range !== 'string') return false;
  return range.trim().split(/\s+/).every((part) => {
    const match = /^(>=|<=|>|<|\^|~|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(part);
    if (!match) return false;
    const op = match[1] ?? '=';
    const parts = [match[2], match[3], match[4]].map((value) => (value === undefined || value === 'x' || value === '*' ? null : Number(value)));
    const low = [parts[0], parts[1] ?? 0, parts[2] ?? 0];
    if (op === '>=') return compare(version, low) >= 0;
    if (op === '>') return compare(version, low) > 0;
    if (op === '<=') return compare(version, low) <= 0;
    if (op === '<') return compare(version, low) < 0;
    if (op === '^' || op === '~') {
      const high = op === '^'
        ? (low[0] > 0 ? [low[0] + 1, 0, 0] : parts[1] !== null ? [0, low[1] + 1, 0] : [0, 0, low[2] + 1])
        : [low[0], low[1] + 1, 0];
      return compare(version, low) >= 0 && compare(version, high) < 0;
    }
    return parts.every((part, index) => part === null || part === version[index]);
  });
}
