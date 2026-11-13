import { parseVerdict } from '../../lib/verdict.mjs';

/** Continuation decision words (machine contract, kept verbatim). */
export const DECISIONS = Object.freeze(['continue', 'wait', 'ask', 'done', 'stop']);

export const CLASSES = Object.freeze([
  'ok',
  'developer_failure',
  'test_failure',
  'reviewer_unavailable',
  'review_passed',
  'review_rejected',
  'human_block',
  'scope_mismatch',
  'finalize_failure',
]);

// First-line verdict contract: `审查结论：通过 | 打回 | 阻塞`. The regex only captures the word;
// parseVerdict (lib/verdict.mjs) does the actual interpretation.
const VERDICT_LINE = /^审查结论[：:]\s*(\S+)\s*$/;

function result(cls, decision, extra = {}) {
  // Every class preserves artifacts; only developer-side failures and valid rejections spend a developer retry.
  const consumesDeveloperRetry = ['developer_failure', 'test_failure', 'review_rejected'].includes(cls);
  return { class: cls, decision, consumesDeveloperRetry, preserveArtifacts: true, ...extra };
}

// Success is a numeric exit code 0 and no terminating signal. A missing or null exit code (a signal-killed child, an
// empty handler result) is never success, and any truthy `timedOut` is a timeout (C1, C2).
const timedOut = (e) => Boolean(e.timedOut);
const succeeded = (e) => typeof e.exitCode === 'number' && e.exitCode === 0 && !e.signal && !timedOut(e);
const failed = (e) => !succeeded(e);
const failReason = (e) => (timedOut(e) ? 'timeout' : e.signal ? 'signal' : 'nonzero_exit');
const empty = (e) => typeof e.output !== 'string' || e.output.trim() === '';

// A blocking / in-scope-miss finding counts as evidenced only with a non-empty evidence string. Findings are
// untrusted data: their text is never read as a verdict or an instruction.
const EVIDENCED = new Set(['blocking', 'in-scope miss']);
const unevidenced = (findings) => Array.isArray(findings) && findings.some((f) =>
  EVIDENCED.has(f?.classification) && !(typeof f.evidence === 'string' && f.evidence.trim() !== ''));

/**
 * Classify one step outcome.
 * @param {{stage:'developer'|'test'|'reviewer'|'finalize', exitCode?:number|null, signal?:string|null, timedOut?:boolean,
 *   output?:string, findings?:Array<object>, scopeMismatch?:boolean, humanBlock?:boolean}} event
 */
export function classify(event) {
  if (!event || typeof event !== 'object') throw new TypeError('event must be an object');
  if (event.scopeMismatch) return result('scope_mismatch', 'ask', { reason: 'scope_mismatch' });
  if (event.humanBlock) return result('human_block', 'ask', { reason: 'human_block' });

  switch (event.stage) {
    case 'developer':
      if (failed(event)) return result('developer_failure', 'continue', { reason: failReason(event) });
      if (empty(event)) return result('developer_failure', 'continue', { reason: 'empty_output' });
      return result('ok', 'continue');
    case 'test':
      if (failed(event)) return result('test_failure', 'continue', { reason: failReason(event) });
      return result('ok', 'continue');
    case 'finalize':
      if (event.retryableGateFailure === true && failed(event)) return result('test_failure', 'continue', { reason: 'actionable_safety_reject' });
      // Finalizing may have had external side effects, so a failure is never retried from development.
      if (failed(event)) return result('finalize_failure', 'ask', { reason: failReason(event) });
      return result('ok', 'done');
    case 'reviewer': {
      if (failed(event)) return result('reviewer_unavailable', 'wait', { reason: failReason(event) });
      if (empty(event)) return result('reviewer_unavailable', 'wait', { reason: 'empty_output' });
      const firstLine = event.output.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
      const match = VERDICT_LINE.exec(firstLine.trim());
      let verdict;
      try { verdict = match ? parseVerdict(match[1]) : undefined; } catch { verdict = undefined; }
      if (!verdict) return result('reviewer_unavailable', 'wait', { reason: 'unparseable_verdict' });
      if (verdict === 'passed') return result('review_passed', 'continue', { verdict });
      if (verdict === 'rejected') {
        return unevidenced(event.findings)
          ? result('reviewer_unavailable', 'wait', { reason: 'unevidenced_blocking_findings' })
          : result('review_rejected', 'continue', { verdict, ...(event.ruleRelated === true ? { ruleRelated: true } : {}) });
      }
      return result('human_block', 'ask', { verdict, reason: 'review_blocked' });
    }
    default:
      throw new TypeError(`Unknown stage: ${String(event.stage)}`);
  }
}
