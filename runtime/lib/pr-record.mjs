// Machine-readable merge record for a loop PR. Pure: no fs, no network, no clock.
export const GATE1_VERDICT = '审查结论：通过';
const GATES = ['gate0', 'gate1', 'gate2', 'ci'];
const BLOCK = /```rt-record\n[\s\S]*?\n```/g;
const isText = (value) => typeof value === 'string' && value.length > 0;
const isCount = (value) => Number.isFinite(value) && value >= 0;

/** Build the record from the passed gates; `rounds` is a roundMeta map keyed by gate, values are never invented. */
export function buildPrRecord({ issue, head, tree, passed, rounds = {}, usage }) {
  const gates = GATES.filter((gate) => passed.includes(gate));
  const meta = (gate) => rounds[gate] ?? {};
  return {
    issue,
    head,
    tree,
    rounds: gates.map((gate) => ({
      gate, role: meta(gate).role ?? null, harness: meta(gate).harness ?? null, model: meta(gate).model ?? null,
      degraded: meta(gate).degraded ?? false, chiefImplemented: meta(gate).chiefImplemented ?? false,
    })),
    verdicts: [{ gate: 'gate1', role: meta('gate1').role ?? null, verdict: GATE1_VERDICT, sha: head }],
    checks: gates.map((name) => ({ name, result: 'passed', sha: head })),
    usage: usage
      ? { usageKnown: true, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, calls: usage.calls }
      : { usageKnown: false },
  };
}

/** Return `{ ok: true }` or `{ ok: false, reason }`; bad data is reported, never thrown. */
export function validatePrRecord(record, { head, tree, requiredGates = [] }) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'record is missing' };
  if (![record.issue, record.head, record.tree].every(isText)) return { ok: false, reason: 'issue, head, and tree must be non-empty strings' };
  if (!Array.isArray(record.verdicts) || record.verdicts.length === 0) return { ok: false, reason: 'verdicts are missing' };
  if (record.verdicts.some((verdict) => verdict?.sha !== head)) return { ok: false, reason: 'verdict sha does not match head' };
  const checks = Array.isArray(record.checks) ? record.checks : [];
  if (checks.some((check) => check?.sha !== head)) return { ok: false, reason: 'check sha does not match head' };
  if (checks.some((check) => check?.result !== 'passed')) return { ok: false, reason: 'a check did not pass' };
  const missing = requiredGates.find((gate) => !checks.some((check) => check.name === gate));
  if (missing) return { ok: false, reason: `required check ${missing} is missing` };
  const usage = record.usage;
  const complete = usage?.usageKnown === true && [usage.inputTokens, usage.outputTokens, usage.calls].every(isCount);
  if (!(usage?.usageKnown === false && Object.keys(usage).length === 1) && !complete) return { ok: false, reason: 'usage is malformed' };
  return { ok: true };
}

/** The parsed record from the single rt-record fenced block, or null when absent or unparseable. */
export function extractPrRecord(body) {
  const block = typeof body === 'string' ? body.match(BLOCK) : null;
  if (!block) return null;
  try {
    return JSON.parse(block[0].slice('```rt-record\n'.length, -'\n```'.length));
  } catch {
    return null;
  }
}

/** Replace the rt-record block in `body`, or append one; the result always holds exactly one block. */
export function upsertPrRecord(body, record) {
  const block = `\`\`\`rt-record\n${JSON.stringify(record, null, 2)}\n\`\`\``;
  let placed = false;
  const out = body.replace(BLOCK, () => { if (placed) return ''; placed = true; return block; });
  return placed ? out : `${body.trimEnd()}\n\n${block}\n`;
}
