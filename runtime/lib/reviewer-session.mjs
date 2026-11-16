import { execFile } from 'node:child_process';
import { parseVerdict } from '../../lib/verdict.mjs';
import { childEnv } from './agent-adapter.mjs';

// First-line verdict contract: `Verdict: pass | reject | block` (the legacy Chinese label is an alias). Anything else is blocked.
const VERDICT_LINE = /^(?:Verdict|审查结论)\s*[:：]\s*(\S+)\s*$/i;
const STATUS = { passed: 'pass', rejected: 'reject', blocked: 'blocked' };

const statusOf = (text) => {
  const word = text.split('\n', 1)[0].trim().match(VERDICT_LINE)?.[1] ?? '';
  try { return STATUS[parseVerdict(word)]; } catch { return 'blocked'; }
};

/** Read-only review prompt: the reviewer judges the recorded Gate 0 evidence and never runs tests itself. */
export function buildReviewerPrompt({ head, gate0Summary }) {
  return [
    `Review the change at head ${head}. Read-only review: do not run tests and do not modify files.`,
    `Recorded Gate 0 summary (the test evidence to rely on):\n${gate0Summary}`,
    'Reply with the verdict on the first line exactly as `Verdict: pass` or `Verdict: reject` or `Verdict: block`, then your rationale.',
  ].join('\n\n');
}

/**
 * Independent Gate 1 review: runs the reviewer as a separate OS process (RT_REVIEWER_COMMAND, default `pi -p`).
 * The command is split on whitespace and spawned without a shell; the prompt is passed as the last argument.
 * If the process cannot start and `review` is supplied, falls back to a single-session review (`independent: false`).
 */
export function runSeparateReviewer({ head, gate0Summary, model, env = process.env, review }) {
  const [file, ...args] = (env.RT_REVIEWER_COMMAND ?? 'pi -p').trim().split(/\s+/);
  const prompt = buildReviewerPrompt({ head, gate0Summary });
  return new Promise((resolve, reject) => {
    const child = execFile(file, [...args, ...(model ? ['--model', model] : []), prompt], { env: childEnv(env) }, (error, stdout) => {
      if (error?.code === 'ENOENT' && review) return resolve(reviewInSession({ head, gate0Summary, review }));
      if (error?.code === 'ENOENT') return reject(Object.assign(error, { code: 'REVIEWER_UNAVAILABLE' }));
      resolve({ status: statusOf(stdout), head, independent: true, pid: child.pid, exitCode: child.exitCode, rationale: stdout.split('\n').slice(1).join('\n').trim() });
    });
  });
}

/**
 * Degraded single-session review: `review(prompt)` runs in the same session as the author.
 * The result is never independent and is refused as a Gate 1 pass by gates.mjs.
 */
export async function reviewInSession({ head, gate0Summary, review }) {
  const text = await review(buildReviewerPrompt({ head, gate0Summary }));
  return { status: statusOf(text), head, independent: false, note: 'not independent' };
}
