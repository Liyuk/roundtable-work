const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'into', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'with', 'that', 'this', 'will', 'should']);
const DAY = 86_400_000;

/** Lowercase word tokens with stopwords removed. */
export const tokens = text => new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter(token => token && !STOPWORDS.has(token)));

/** Jaccard similarity of two token sets; 0 when both are empty. */
export function similarity(a, b) {
  const union = new Set([...a, ...b]).size;
  return union ? [...a].filter(token => b.has(token)).length / union : 0;
}

const acceptance = body => /^#{1,6}\s+Acceptance criteria\s*\r?\n([\s\S]*?)(?=^#{1,6}\s+|(?![\s\S]))/im.exec(body)?.[1] ?? '';
const textOf = issue => tokens(`${issue.title ?? ''} ${acceptance(issue.body ?? '')}`);

/** Numbers of closed issues (closed within the window) whose similarity to the draft meets the threshold. */
export function overlappingIssues(draft, closed = [], { now = Date.now(), days = 14, threshold = 0.2 } = {}) {
  const draftTokens = textOf(draft);
  return closed
    .filter(issue => issue.state === 'CLOSED' && Date.parse(issue.closedAt) >= now - days * DAY)
    .filter(issue => similarity(draftTokens, textOf(issue)) > threshold)
    .map(issue => issue.number);
}

const held = issue => (issue.labels ?? []).some(label => (typeof label === 'string' ? label : label.name) === 'rt:hold');

/**
 * Numbers of open issues and pull requests that duplicate the draft: a pull request linked to the draft's own number
 * (`linked` maps an issue number to its linked pull requests), or a similar title on an open pull request or an older
 * open issue. Titles only, at a high threshold: shared acceptance boilerplate must not make unrelated work a duplicate.
 * Of two similar open issues only the newer one is a duplicate; decomposition parents (`rt:hold`) never count.
 */
export function duplicatesOf(draft, { open = [], linked = {}, threshold = 0.5 } = {}) {
  const draftTokens = tokens(draft.title ?? '');
  const pulls = Object.values(linked).flat();
  const older = open.filter(issue => !held(issue) && (draft.number === undefined || issue.number < draft.number));
  const similar = [...older, ...pulls]
    .filter(item => item.number !== draft.number && similarity(draftTokens, tokens(item.title ?? '')) >= threshold)
    .map(item => item.number);
  const linkedToDraft = (draft.number ? linked[draft.number] ?? [] : []).map(pull => pull.number);
  return [...new Set([...linkedToDraft, ...similar])];
}
