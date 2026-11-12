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
]);

// First-line verdict contract: `审查结论：通过 | 打回 | 阻塞`. The regex only captures the word;
// parseVerdict (lib/verdict.mjs) does the actual interpretation.
const VERDICT_LINE = /^审查结论[：:]\s*(\S+)\s*$/;

function result(cls, decision, extra = {}) {
  // Every class preserves artifacts; only developer-side failures and valid rejections spend a developer retry.
  const consumesDeveloperRetry = ['developer_failure', 'test_failure', 'review_rejected'].includes(cls);
  return { class: cls, decision, consumesDeveloperRetry, preserveArtifacts: true, ...extra };
}

const failed = (e) => e.timedOut === true || (e.exitCode ?? 0) !== 0;
const empty = (e) => typeof e.output !== 'string' || e.output.trim() === '';

/**
 * Classify one step outcome.
 * @param {{stage:'developer'|'test'|'reviewer'|'finalize', exitCode?:number, timedOut?:boolean,
 *   output?:string, scopeMismatch?:boolean, humanBlock?:boolean}} event
 */
export function classify(event) {
  if (!event || typeof event !== 'object') throw new TypeError('event must be an object');
  if (event.scopeMismatch) return result('scope_mismatch', 'ask', { reason: 'scope_mismatch' });
  if (event.humanBlock) return result('human_block', 'ask', { reason: 'human_block' });

  switch (event.stage) {
    case 'developer':
      if (failed(event)) return result('developer_failure', 'continue', { reason: event.timedOut ? 'timeout' : 'nonzero_exit' });
      if (empty(event)) return result('developer_failure', 'continue', { reason: 'empty_output' });
      return result('ok', 'continue');
    case 'test':
      if (failed(event)) return result('test_failure', 'continue', { reason: event.timedOut ? 'timeout' : 'nonzero_exit' });
      return result('ok', 'continue');
    case 'finalize':
      if (failed(event)) return result('developer_failure', 'continue', { reason: event.timedOut ? 'timeout' : 'nonzero_exit' });
      return result('ok', 'done');
    case 'reviewer': {
      if (event.timedOut) return result('reviewer_unavailable', 'wait', { reason: 'timeout' });
      if ((event.exitCode ?? 0) !== 0) return result('reviewer_unavailable', 'wait', { reason: 'nonzero_exit' });
      if (empty(event)) return result('reviewer_unavailable', 'wait', { reason: 'empty_output' });
      const firstLine = event.output.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
      const match = VERDICT_LINE.exec(firstLine.trim());
      let verdict;
      try { verdict = match ? parseVerdict(match[1]) : undefined; } catch { verdict = undefined; }
      if (!verdict) return result('reviewer_unavailable', 'wait', { reason: 'unparseable_verdict' });
      if (verdict === 'passed') return result('review_passed', 'continue', { verdict });
      if (verdict === 'rejected') return result('review_rejected', 'continue', { verdict });
      return result('human_block', 'ask', { verdict, reason: 'review_blocked' });
    }
    default:
      throw new TypeError(`Unknown stage: ${String(event.stage)}`);
  }
}
