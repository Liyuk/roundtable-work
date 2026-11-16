/**
 * Parse a verdict word (English writer form or legacy alias) and return the normalized English form.
 * Writers emit `Verdict: pass|reject|block`; the legacy Chinese first line is accepted as an alias only.
 * @param {string} text - The verdict word to parse
 * @returns {'passed' | 'rejected' | 'blocked'} - Normalized verdict type
 * @throws {TypeError} - If the input cannot be recognized as a valid verdict
 */
export function parseVerdict(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`Expected string, got ${typeof text}`);
  }

  // Trim whitespace and newlines
  const normalized = text.trim().toLowerCase();

  if (normalized === 'pass' || normalized === 'passed' || normalized === '通过') {
    return 'passed';
  }
  // returned is an alias for rejected
  if (normalized === 'reject' || normalized === 'rejected' || normalized === 'returned' || normalized === '打回') {
    return 'rejected';
  }
  if (normalized === 'block' || normalized === 'blocked' || normalized === '阻塞') {
    return 'blocked';
  }

  // If we reach here, the input is not recognized
  throw new TypeError(
    `Unrecognized verdict: "${text}". Expected one of: pass, reject, block (legacy aliases: passed, rejected, blocked, returned, and the Chinese words)`
  );
}
