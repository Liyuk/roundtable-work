/**
 * Parse verdict text in Chinese or English and return normalized English form.
 * @param {string} text - The verdict text to parse
 * @returns {'passed' | 'rejected' | 'blocked'} - Normalized verdict type
 * @throws {TypeError} - If the input cannot be recognized as a valid verdict
 */
export function parseVerdict(text) {
  if (typeof text !== 'string') {
    throw new TypeError(`Expected string, got ${typeof text}`);
  }

  // Trim whitespace and newlines
  const normalized = text.trim().toLowerCase();

  // Chinese forms
  if (normalized === '通过') {
    return 'passed';
  }
  if (normalized === '打回') {
    return 'rejected';
  }
  if (normalized === '阻塞') {
    return 'blocked';
  }

  // English forms (case-insensitive)
  if (normalized === 'passed') {
    return 'passed';
  }
  if (normalized === 'rejected') {
    return 'rejected';
  }
  if (normalized === 'blocked') {
    return 'blocked';
  }

  // Aliases
  if (normalized === 'returned') {
    return 'rejected';
  }

  // If we reach here, the input is not recognized
  throw new TypeError(
    `Unrecognized verdict: "${text}". Expected one of: passed, rejected, blocked (or Chinese: 通过, 打回, 阻塞, or alias: returned)`
  );
}
