// Supervisor actuator: the only mutating path. Every side effect is injected; every call is ledgered before and after.
export const ALLOWED_ACTIONS = Object.freeze(['restart-daemon', 'pause-queue', 'void-stale-pause', 'reprompt', 'rollback', 'add-label', 'convert-to-draft']);
export const FORBIDDEN_ACTIONS = Object.freeze(['merge', 'close', 'revert', 'force-push', 'delete-branch', 'change-budget', 'change-policy', 'edit-prompt', 'enable-jev', 'handle-credentials']);

const isText = (v) => typeof v === 'string' && v.length > 0;
const isPositiveInt = (n) => Number.isInteger(n) && n > 0;
const rejected = (reason) => ({ status: 'rejected', reason });

export function createActuator({ ledger, now, notify, daemon, queue, github, prompts, releases, config: { maxRestartFailures = 3, backoffBaseMs = 60000 } = {} }) {
  let consecutiveFailures = 0;
  let nextAllowedAt = 0;

  const perform = {
    async 'restart-daemon'(args, reason, base) {
      if (now() < nextAllowedAt) return rejected(`rejected: backoff until ${nextAllowedAt}`);
      try {
        await daemon.restart();
      } catch (err) {
        consecutiveFailures += 1;
        nextAllowedAt = now() + backoffBaseMs * 2 ** (consecutiveFailures - 1);
        if (consecutiveFailures === maxRestartFailures) {
          const why = `${consecutiveFailures} consecutive daemon restart failures`;
          queue.pause(why);
          notify(why);
          ledger.record({ ...base, action: 'pause-queue', reason: `auto-pause: ${why}; notified` });
        }
        throw err;
      }
      consecutiveFailures = 0;
      nextAllowedAt = 0;
      return { status: 'done' };
    },
    async 'pause-queue'(args, reason) {
      queue.pause(reason);
      return { status: 'done' };
    },
    async 'void-stale-pause'(args) {
      if (!isText(args.ref)) return rejected('rejected: ref must be a non-empty string');
      queue.requeue(args.ref);
      return { status: 'done' };
    },
    async reprompt(args) {
      if (!prompts.isApproved(args.variantId)) return rejected('rejected: prompt variant not approved');
      await prompts.apply(args.variantId);
      return { status: 'done' };
    },
    async rollback(args) {
      if (!['config', 'prompt'].includes(args.target)) return rejected('rejected: rollback target must be config or prompt');
      const version = releases.lastKnownGood(args.target);
      if (!version) return rejected('rejected: no lastKnownGood for target');
      await releases.restore(args.target, version);
      return { status: 'done' };
    },
    async 'add-label'(args) {
      if (args.label !== undefined && args.label !== 'needs-owner') return rejected('rejected: label not allow-listed');
      if (!isPositiveInt(args.number)) return rejected('rejected: number must be a positive integer');
      await github.addLabel(args.number, 'needs-owner');
      return { status: 'done' };
    },
    async 'convert-to-draft'(args) {
      if (!isPositiveInt(args.number)) return rejected('rejected: number must be a positive integer');
      await github.convertToDraft(args.number);
      return { status: 'done' };
    },
  };

  return {
    async act({ action, reason, findingSignature, args = {} }) {
      if (!isText(reason) || !isText(findingSignature)) throw new TypeError('reason and findingSignature must be non-empty strings');
      const base = { mode: 'apply', findingSignature };
      if (FORBIDDEN_ACTIONS.includes(action)) {
        const why = `rejected: forbidden action ${action}`;
        ledger.record({ ...base, action, reason: `${why}; ${reason}` });
        return rejected(why);
      }
      if (!ALLOWED_ACTIONS.includes(action)) {
        const why = 'rejected: not allow-listed';
        ledger.record({ ...base, action, reason: `${why}; ${reason}` });
        return rejected(why);
      }
      ledger.record({ ...base, action, reason: `before: ${reason}` });
      let result;
      try {
        result = await perform[action](args, reason, base);
      } catch (err) {
        result = { status: 'failed', reason: `failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      ledger.record({ ...base, action, reason: `after: ${result.reason ?? 'ok'}` });
      return result;
    },
  };
}
