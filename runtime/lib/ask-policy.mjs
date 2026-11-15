// RT-S9a ask policy (docs/self-supervision.md, section (d)). Pure: maps a decision card to a default answer, or blocks.

export const SCOPE_KINDS = Object.freeze(['acceptance-needs-files', 'criterion-unreliable', 'scope-change', 'none']);
const OWNER_CATEGORIES = Object.freeze(['credentials', 'destructive', 'production']);
const MAX_TOUCH_EXPANSION = 5;

/** Fixed keyword rules for a card whose scopeKind is missing or outside SCOPE_KINDS. */
export function inferScopeKind(question = '') {
  const text = String(question).toLowerCase();
  if (text.includes('touch set') && (text.includes('acceptance') || text.includes('criterion'))) return 'acceptance-needs-files';
  if (['shared host', 'other processes', 'other worktrees', 'global count', 'unreliable'].some((k) => text.includes(k))) return 'criterion-unreliable';
  return 'none';
}

export function resolveAsk({ card }) {
  if (OWNER_CATEGORIES.includes(card.category)) return { outcome: 'block', reason: 'owner-question' };

  const scopeKind = SCOPE_KINDS.includes(card.scopeKind) ? card.scopeKind : inferScopeKind(card.question);
  if (scopeKind === 'acceptance-needs-files') {
    const paths = card.evidence;
    if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p.length > 0)) {
      return { outcome: 'block', reason: 'no-default' };
    }
    const resolution = paths.length > MAX_TOUCH_EXPANSION ? 'decompose' : 'expand-touch-set';
    return { outcome: 'resolve', resolution, paths, rule: 'acceptance-needs-files' };
  }

  const hasRecommendation = Array.isArray(card.options) && card.options.includes(card.recommendation);
  if (!hasRecommendation) return { outcome: 'block', reason: 'no-default' };
  if (scopeKind === 'criterion-unreliable') {
    return { outcome: 'resolve', resolution: 'isolated-reading', choice: card.recommendation, rule: 'criterion-unreliable' };
  }
  return { outcome: 'resolve', resolution: 'recommendation', choice: card.recommendation, rule: 'recommendation' };
}
