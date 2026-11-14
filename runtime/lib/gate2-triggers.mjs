// Translation paths: i18n/locale/translation folders, PO/XLIFF catalogues, and per-language markdown (name.zh.md).
const TRANSLATION = [/(^|\/)(i18n|locales?|translations?)\//, /\.(po|xliff)$/, /\.(zh|en|ja)(\.[a-z-]+)?\.md$/];
// Protocol / machine-field code and the prompt/template files that define the verdict contract.
const PROTOCOL = [/(^|\/)lib\/(verdict|classify|decide|review-ledger)\.mjs$/, /^\.agents\/skills\/roundtable-work\/(templates|prompts)\//];
const MIN_RATIONALE = 40;

/** Reasons that force Gate 2 even when the work is not marked high-risk; an empty array means no trigger. */
export function gate2Triggers({ changedFiles = [], gate1 }) {
  const reasons = [];
  if (changedFiles.some(file => TRANSLATION.some(pattern => pattern.test(file)))) reasons.push('translation');
  if (changedFiles.some(file => PROTOCOL.some(pattern => pattern.test(file)))) reasons.push('protocol');
  const rationale = gate1?.rationale;
  if (typeof rationale !== 'string' || rationale.trim().length < MIN_RATIONALE) reasons.push('thin-rationale');
  return reasons;
}
