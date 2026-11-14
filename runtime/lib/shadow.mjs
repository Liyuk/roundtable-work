import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Live GitHub operations that only read state; every other method of the client is fenced. */
const GITHUB_READS = new Set(['getPullRequest', 'requiredGreen', 'mainStatus', 'recordedEscalationApproval',
  'getOwner', 'getRepository', 'listRecentMerges', 'listLinkedPullRequests', 'listIssues', 'getIssue', 'listComments', 'listOpenPullRequests']);

/**
 * Wrap a provider so that only `reads` are forwarded; each other method of the live client is a no-op that records
 * its name in `attempted` and resolves undefined, so the pass continues without writing. Absent methods stay absent,
 * so optional-capability checks behave as on the live client.
 */
export function createShadowProvider(client, reads, attempted = []) {
  return new Proxy(client, {
    get(target, prop) {
      if (typeof prop === 'string' && prop in target && !reads.has(prop)) {
        return async () => { attempted.push(prop); };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const createShadowGitHub = (client, attempted) => createShadowProvider(client, GITHUB_READS, attempted);

/** Per-issue decision differences; a missing side is null. Identical decisions give []. */
export function diffDecisions(shadow, live) {
  const issues = [...new Set([...Object.keys(shadow), ...Object.keys(live)])].sort();
  return issues.flatMap((issue) => {
    const decisions = { shadow: shadow[issue] ?? null, live: live[issue] ?? null };
    return decisions.shadow === decisions.live ? [] : [{ issue, ...decisions }];
  });
}

/** Write `<workRoot>/shadow/cycle-<n>.jsonl`, one line per differing decision (empty when none). */
export async function writeShadowCycle({ workRoot, outcomes, live = {} }) {
  const dir = join(workRoot, 'shadow');
  await mkdir(dir, { recursive: true });
  const cycles = (await readdir(dir)).map((name) => /^cycle-(\d+)\.jsonl$/.exec(name)?.[1]).filter(Boolean).map(Number);
  const cycle = Math.max(0, ...cycles) + 1;
  const diff = diffDecisions(Object.fromEntries(outcomes.map((o) => [o.id, o.decision])), live);
  await writeFile(join(dir, `cycle-${cycle}.jsonl`), diff.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { flag: 'wx' });
  return { cycle, diff };
}
