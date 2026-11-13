import { readFile as readDiskFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const VERDICTS = Object.freeze({ pass: '审查结论：通过', reject: '审查结论：打回', block: '审查结论：阻塞' });
const CLASSES = ['blocking', 'in-scope miss', 'out-of-scope follow-up'];
const STATUSES = ['open', 'fixed', 'follow-up'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SHA = /^[a-f0-9]{40,64}$/i;

/** Validate a frozen review ledger. Findings' prose is descriptive and never drives a verdict. */
export function validateReviewLedger(value, options = {}) {
  if (!plain(options)) throw new TypeError('options must be an object');
  exact(options, ['currentHeadSha', 'frozen'], 'options');
  if (!plain(value)) throw new TypeError('ledger must be an object');
  exact(value, ['version', 'freeze', 'findings', 'riskList'], 'ledger');
  if (value.version !== 1) throw new TypeError('ledger version must be 1');
  validateFreeze(value.freeze);
  const { currentHeadSha, frozen } = options;
  if (!sha(currentHeadSha)) throw new TypeError('currentHeadSha must be a commit SHA');
  if (!validFreeze(frozen) || !isDeepStrictEqual(value.freeze, frozen)) {
    throw new TypeError('ledger freeze does not match the frozen review scope');
  }
  if (!Array.isArray(value.findings)) throw new TypeError('findings must be an array');
  if (value.riskList !== null && !validRiskList(value.riskList)) throw new TypeError('riskList must be null or include a threatModel and risks');
  const riskBlocked = value.freeze.highRisk && value.riskList === null;

  const ids = new Set();
  const followUps = [];
  let blocked = false;
  for (const finding of value.findings) {
    validateFinding(finding);
    if (ids.has(finding.id)) throw new TypeError(`duplicate finding id: ${finding.id}`);
    ids.add(finding.id);
    const frozenMustFix = frozen.mustFixIds.includes(finding.id);
    if (finding.classification === 'blocking' && !frozenMustFix) throw new TypeError(`blocking finding ${finding.id} is not in the frozen must-fix set`);
    if (finding.classification === 'in-scope miss' && frozenMustFix) throw new TypeError(`in-scope miss ${finding.id} must be a new finding outside the frozen must-fix set`);
    if (finding.classification === 'out-of-scope follow-up') {
      followUps.push({ id: finding.id, summary: finding.summary, severity: finding.severity });
      continue;
    }
    if (finding.status !== 'fixed' || finding.retest.result !== 'passed' || finding.retest.headSha !== currentHeadSha) blocked = true;
  }
  for (const id of frozen.mustFixIds) if (!value.findings.some(finding => finding.id === id && finding.classification === 'blocking')) throw new TypeError(`frozen must-fix ${id} is missing from the findings as blocking`);
  return { verdict: riskBlocked ? VERDICTS.block : blocked ? VERDICTS.reject : VERDICTS.pass, followUps };
}

function validateFreeze(value) {
  if (!validFreeze(value)) throw new TypeError('freeze requires goal, baseSha, headSha, reviewScope, highRisk, and mustFixIds');
}

function validFreeze(value) {
  return plain(value) && exactOrFalse(value, ['goal', 'baseSha', 'headSha', 'reviewScope', 'highRisk', 'mustFixIds'])
    && nonEmpty(value.goal) && sha(value.baseSha) && sha(value.headSha)
    && Array.isArray(value.reviewScope) && value.reviewScope.length > 0
    && value.reviewScope.every(nonEmpty) && new Set(value.reviewScope).size === value.reviewScope.length
    && typeof value.highRisk === 'boolean'
    && Array.isArray(value.mustFixIds) && value.mustFixIds.every(nonEmpty) && new Set(value.mustFixIds).size === value.mustFixIds.length;
}

function validateFinding(value) {
  if (!plain(value)) throw new TypeError('finding must be an object');
  if (value.classification === 'out-of-scope follow-up') {
    exact(value, ['id', 'summary', 'severity', 'classification', 'status'], 'finding');
    if (value.status !== 'follow-up') throw new TypeError('out-of-scope finding status must be follow-up');
  } else {
    exact(value, ['id', 'summary', 'severity', 'classification', 'status', 'evidence', ...(value.status === 'fixed' ? ['fixCommit', 'retest'] : [])], 'finding');
    if (!CLASSES.includes(value.classification)) throw new TypeError('unknown finding classification');
    if (!nonEmpty(value.evidence)) throw new TypeError('blocking and in-scope-miss findings require non-empty evidence');
    if (!STATUSES.includes(value.status) || value.status === 'follow-up') throw new TypeError('unknown or inconsistent finding status');
    if (value.status === 'fixed') {
      if (!sha(value.fixCommit)) throw new TypeError('fixed finding requires a fix commit SHA');
      if (!plain(value.retest)) throw new TypeError('fixed finding requires retest evidence');
      exact(value.retest, ['headSha', 'result'], 'retest');
      if (!sha(value.retest.headSha) || !['passed', 'failed'].includes(value.retest.result)) throw new TypeError('retest requires a head SHA and passed or failed result');
    }
  }
  if (!nonEmpty(value.id) || !nonEmpty(value.summary) || !SEVERITIES.includes(value.severity)) throw new TypeError('finding requires id, summary, and a known severity');
}

function validRiskList(value) {
  return plain(value) && exactOrFalse(value, ['threatModel', 'risks']) && nonEmpty(value.threatModel)
    && Array.isArray(value.risks) && value.risks.length > 0 && value.risks.every(nonEmpty);
}

function exact(value, keys, label) {
  if (!exactOrFalse(value, keys)) throw new TypeError(`${label} has missing or unexpected fields`);
}
function exactOrFalse(value, keys) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && SHA.test(value);

const REVIEW_NOTES_MARKER = '<!-- rt:review-notes -->';
const REVIEW_CONFIG_OFF = Object.freeze({ createFollowupIssues: false });

/** Load the tracked follow-up switch; a missing or malformed file resolves to off. */
export async function readReviewConfig({ readFile = readDiskFile, repoRoot = join(import.meta.dirname, '../..') } = {}) {
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, 'runtime', 'review.config.json'), 'utf8'));
    if (typeof parsed.createFollowupIssues === 'boolean') return parsed;
  } catch {}
  return { ...REVIEW_CONFIG_OFF };
}

/** Put non-blocking findings in one PR comment; follow-up issues are opt-in and off by default. */
export async function reportReviewFindings({ github, pr, findings, config }) {
  const { createFollowupIssues } = config ?? await readReviewConfig();
  const body = `${REVIEW_NOTES_MARKER}\n${findings.map(finding => `- ${finding.id} (${finding.severity}): ${finding.summary}`).join('\n')}`;
  const comment = await github.createComment(pr, body);
  const issues = createFollowupIssues === true
    ? await Promise.all(findings.map(finding => github.createIssue({ title: `Follow-up ${finding.id}: ${finding.summary}`, labels: ['rt:followup', 'rt:go'], body: finding.summary })))
    : [];
  return { comment, issues };
}
