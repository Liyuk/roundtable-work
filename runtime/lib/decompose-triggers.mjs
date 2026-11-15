// Safety-relevant paths and policy words that mark an issue as touching the control plane.
const SAFETY_FILES = /\.githooks\/|bin\/gh\b|runtime\/lib\/guard|\.github\/workflows\/|scripts\/check\.mjs|policy|limits/i;
const DATA_MODEL = /data model|schema|migration|identity/i;

/** Triggers that call for decomposition; an empty array means none fired. Thresholds are strict (>). */
export function decomposeTriggers({ size = 0, acceptance = 0, threatModel = false, safetyFiles = false, dataModel = false } = {},
  { sizeLimit = 400, acceptanceLimit = 8 } = {}) {
  const fired = [];
  if (size > sizeLimit) fired.push('size');
  if (acceptance > acceptanceLimit) fired.push('acceptance');
  if (threatModel) fired.push('threat-model');
  if (safetyFiles) fired.push('safety-files');
  if (dataModel) fired.push('data-model');
  return fired;
}

/** Derive trigger inputs from the issue body text; any explicit input overrides these. */
export function issueSignals(body = '') {
  const section = title => {
    const lines = body.split(/\r?\n/);
    const start = lines.findIndex(line => line.trim().toLowerCase() === `## ${title}`.toLowerCase());
    if (start < 0) return '';
    const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
    return lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  };
  return {
    size: Number(/^Changed lines:\s*(\d+)/m.exec(section('Size estimate'))?.[1] ?? 0),
    acceptance: section('Acceptance criteria').split('\n').filter(line => /^(- |\d+\. )/.test(line)).length,
    threatModel: /threat model/i.test(body),
    safetyFiles: SAFETY_FILES.test(body),
    dataModel: DATA_MODEL.test(body),
    depth: /^Parent: #/m.test(body) ? 1 : 0,
  };
}
