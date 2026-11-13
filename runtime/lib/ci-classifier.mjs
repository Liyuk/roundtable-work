/** Maximum number of repro drafts retained for one PR head. */
export const MAX_REPRO_DRAFTS_PER_PR = 3;

const TRANSIENT = /\b(?:flaky|timeout|timed[- ]?out|runner[- ]?(?:lost|unavailable|offline)|infrastructure)\b/i;
const clean = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value.trim();
};

/** Classify fixture observations by truncated signature across named workflows/platforms. */
export function classifyCiFixtures(observations) {
  if (!Array.isArray(observations) || observations.length === 0) throw new TypeError('observations are required');
  const groups = new Map();
  const greens = [];
  for (const row of observations) {
    if (!row || typeof row !== 'object' || !['failed', 'green'].includes(row.status)) throw new TypeError('invalid fixture observation');
    const workflow = clean(row.workflow, 'workflow');
    const platform = clean(row.platform, 'platform');
    const signature = row.status === 'failed' ? clean(row.signature, 'signature').slice(0, 160) : null;
    if (row.status === 'green') { greens.push({ workflow, platform }); continue; }
    const key = signature;
    const group = groups.get(key) ?? { signature, failures: [], greens: [] };
    group.failures.push({ workflow, platform });
    groups.set(key, group);
  }
  return [...groups.values()].filter((g) => g.signature).map((group) => {
    group.greens = greens.filter((green) => group.failures.some((failure) => failure.workflow === green.workflow));
    const platforms = new Set(group.failures.map((f) => f.platform));
    const greenPlatforms = new Set(group.greens.map((g) => g.platform));
    let classification = 'unknown';
    if (TRANSIENT.test(group.signature)) classification = 'transient';
    else if (platforms.size > 1) classification = 'likely_code_defect';
    else if ([...greenPlatforms].some((p) => !platforms.has(p))) classification = 'likely_platform_specific';
    return { signature: group.signature, classification, failures: group.failures, greens: group.greens,
      record: classification === 'unknown' ? 'Unknown CI failure signature; no repro draft created.' : undefined };
  });
}

// Fixture drafts accept only a bounded vocabulary; arbitrary logs and identifiers cannot
// be reliably recognized as secrets and therefore must never be persisted.
const FIXTURE_WORDS = new Set(['assertion', 'mismatch', 'at', 'test', 'a', 'same', 'failure',
  'linux', 'macos', 'windows', 'safe', 'run', 'fixture', 'repro', 'build', 'failed',
  'first', 'second', 'third', 'extra', 'environment', 'steps', 'reproduce',
  'opaque', 'timeout', 'waiting']);

export function redactCiEvidence(value, { hostnames = [] } = {}) {
  if (typeof value !== 'string') throw new TypeError('evidence must be text');
  if (!Array.isArray(hostnames) || hostnames.some((h) => typeof h !== 'string' || !h)) throw new TypeError('hostnames must be strings');
  const text = value.trim();
  if (!text || !/^[A-Za-z ]+$/.test(text) || text.split(/ +/).some((word) => !FIXTURE_WORDS.has(word.toLowerCase())) ||
      hostnames.some((host) => text.toLowerCase().includes(host.toLowerCase()))) {
    throw new Error('Evidence is outside the safe fixture vocabulary');
  }
  return text;
}

/** Save at most one redacted draft per PR head/signature. No executor is claimed or dispatched here. */
export async function saveReproDraft({ store, head, signature, targetEnvironment, evidence, steps, observations, hostnames = [], authorizedExecutor = false }) {
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') throw new TypeError('store.load and store.save are required');
  head = clean(head, 'head');
  const rawSignature = clean(signature, 'signature').slice(0, 160);
  const result = classifyCiFixtures(observations).find((item) => item.signature === rawSignature);
  if (!result || result.classification !== 'likely_platform_specific' ||
      !result.failures.some((failure) => failure.platform === targetEnvironment)) {
    throw new Error('A matching platform-specific classification is required');
  }
  signature = redactCiEvidence(rawSignature, { hostnames });
  targetEnvironment = redactCiEvidence(clean(targetEnvironment, 'targetEnvironment'), { hostnames });
  if (!Array.isArray(steps) || !steps.length) throw new TypeError('reproduction steps are required');
  const old = await store.load(head);
  const drafts = Array.isArray(old?.drafts) ? old.drafts : [];
  const existing = drafts.find((d) => d.signature === signature);
  if (existing) return { status: 'deduplicated', draft: existing };
  if (drafts.length >= MAX_REPRO_DRAFTS_PER_PR) return { status: 'capped', cap: MAX_REPRO_DRAFTS_PER_PR };
  const redactedEvidence = redactCiEvidence(evidence, { hostnames });
  const draft = { head, signature, targetEnvironment, evidence: redactedEvidence,
    steps: steps.map((step) => redactCiEvidence(clean(step, 'step'), { hostnames })),
    status: authorizedExecutor ? 'ready' : 'wait', decision: authorizedExecutor ? 'continue' : 'wait' };
  await store.save(head, { drafts: [...drafts, draft] });
  return { status: 'saved', draft };
}
