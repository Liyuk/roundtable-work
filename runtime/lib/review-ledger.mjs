import { readFile as readDiskFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

// Recorded values map to the frozen states passed / rejected / blocked (lib/verdict.mjs); writers emit the English line.
const VERDICTS = Object.freeze({ pass: 'Verdict: pass', reject: 'Verdict: reject', block: 'Verdict: block' });
const CLASSES = ['blocking', 'in-scope miss', 'out-of-scope follow-up'];
const STATUSES = ['open', 'fixed', 'follow-up'];
const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const SHA = /^[a-f0-9]{40,64}$/i;
const LEDGER_KEYS = ['version', 'freeze', 'findings', 'riskList'];

/** Validate a frozen review ledger. Findings' prose is descriptive and never drives a verdict. */
export function validateReviewLedger(value, options = {}) {
  if (!plain(options)) throw new TypeError('options must be an object');
  exact(options, ['currentHeadSha', 'frozen'], 'options');
  if (!plain(value)) throw new TypeError('ledger must be an object');
  exact(value, value.waivers === undefined ? LEDGER_KEYS : [...LEDGER_KEYS, 'waivers'], 'ledger');
  if (value.version !== 1) throw new TypeError('ledger version must be 1');
  validateFreeze(value.freeze);
  const { currentHeadSha, frozen } = options;
  if (!sha(currentHeadSha)) throw new TypeError('currentHeadSha must be a commit SHA');
  if (!validFreeze(frozen) || !isDeepStrictEqual(value.freeze, frozen)) {
    throw new TypeError('ledger freeze does not match the frozen review scope');
  }
  if (!Array.isArray(value.findings)) throw new TypeError('findings must be an array');
  if (value.riskList !== null && !validRiskList(value.riskList)) throw new TypeError('riskList must be null or include a threatModel and risks');
  const waivers = value.waivers ?? [];
  if (!Array.isArray(waivers) || !waivers.every(validWaiver)) throw new TypeError('waivers must list { id, ownerComment } with non-empty strings');
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
    // An owner waiver only suppresses a blocking finding with the same id; evidence rules above still apply.
    const waived = finding.classification === 'blocking' && waivers.some(waiver => waiver.id === finding.id);
    if (!waived && (finding.status !== 'fixed' || finding.retest.result !== 'passed' || finding.retest.headSha !== currentHeadSha)) blocked = true;
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

function validWaiver(value) {
  return plain(value) && exactOrFalse(value, ['id', 'ownerComment']) && nonEmpty(value.id) && nonEmpty(value.ownerComment);
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
const FOLLOW_UP_SEVERITIES = ['critical', 'high'];
const REVIEW_CONFIG_OFF = Object.freeze({ createFollowupIssues: false });

/** Load the tracked follow-up switch; a missing or malformed file resolves to off. */
export async function readReviewConfig({ readFile = readDiskFile, repoRoot = join(import.meta.dirname, '../..') } = {}) {
  try {
    const parsed = JSON.parse(await readFile(join(repoRoot, 'runtime', 'review.config.json'), 'utf8'));
    if (typeof parsed.createFollowupIssues === 'boolean') return parsed;
  } catch {}
  return { ...REVIEW_CONFIG_OFF };
}

/** Stable identity of a finding across rounds: file, rule (or class), and the normalized message. */
export const fingerprint = finding => createHash('sha256')
  .update(JSON.stringify([finding.file ?? '', finding.rule ?? finding.classification ?? '', finding.summary.trim().replace(/\s+/g, ' ').toLowerCase()]))
  .digest('hex').slice(0, 16);

/** Mark findings against `previous` records ({ fingerprint, status }) from earlier rounds of the same issue. */
export function triageFindings(findings, previous = []) {
  const prior = new Map(previous.map(record => [record.fingerprint, record.status]));
  return findings.map(finding => {
    const id = fingerprint(finding);
    const repeat = prior.has(id);
    const status = repeat ? prior.get(id) : 'open';
    return { ...finding, fingerprint: id, repeat, status, fix: finding.classification === 'blocking' && status === 'open' };
  });
}

/** High and critical in-scope findings get follow-up issues (switch on, new only); everything else goes in one PR comment. */
export async function reportReviewFindings({ github, pr, findings, config, previous = [] }) {
  const { createFollowupIssues } = config ?? await readReviewConfig();
  const triaged = triageFindings(findings, previous);
  const filed = createFollowupIssues === true
    ? triaged.filter(finding => !finding.repeat && finding.classification !== 'out-of-scope follow-up' && FOLLOW_UP_SEVERITIES.includes(finding.severity))
    : [];
  const issues = await Promise.all(filed.map(finding => github.createIssue({ title: `Follow-up ${finding.id}: ${finding.summary}`, labels: ['rt:followup', 'rt:go'], body: finding.summary })));
  const notes = triaged.filter(finding => !filed.includes(finding));
  const body = `${REVIEW_NOTES_MARKER}\n${notes.map(finding => `- ${finding.id} (${finding.severity})${finding.repeat ? ' repeat' : ''}: ${finding.summary}`).join('\n')}`;
  const existing = (await github.listComments?.(pr) ?? []).find(comment => comment.body?.startsWith(REVIEW_NOTES_MARKER));
  const comment = existing ? await github.updateComment(existing.id, body) : await github.createComment(pr, body);
  return { comment, issues, records: triaged.map(({ id, severity, fingerprint: fp, status, repeat, fix }) => ({ id, severity, fingerprint: fp, status, repeat, fix })) };
}
