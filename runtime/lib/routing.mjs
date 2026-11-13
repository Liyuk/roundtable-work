const ROUTE_ENV = Object.freeze({
  chief: ['RT_CHIEF_MODEL', 'RT_MODEL'],
  development: ['RT_DEVELOPER_MODEL', 'RT_MODEL'],
  review: ['RT_REVIEWER_MODEL', 'RT_MODEL'],
  verification: ['RT_VERIFICATION_MODEL', 'RT_MODEL'],
  escalation: ['RT_DECIDER_MODEL'],
  'cross-check': ['RT_CROSSCHECK_MODEL'],
});
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;
const DEFAULT_MODELS = ['gpt-6-luna', 'gpt-6.1-terra', 'deepseek-v4-pro'];

export function escalationAttemptBudget(env = process.env) {
  const budget = env.RT_DECIDE_MAX === undefined ? 2 : Number(env.RT_DECIDE_MAX);
  if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('RT_DECIDE_MAX must be a positive integer');
  return budget;
}

export function createModelRouter(env = process.env) {
  // A trusted deployment may replace the defaults with its own approved model IDs.
  const allowed = env.RT_ALLOWED_MODELS === undefined ? DEFAULT_MODELS : env.RT_ALLOWED_MODELS.split(',').map(model => model.trim());
  if (!allowed.length || allowed.some(model => !MODEL_ID.test(model) || model.toLowerCase().includes(['hai', 'ku'].join('')))) {
    throw new TypeError('RT_ALLOWED_MODELS must contain valid model identifiers');
  }
  const routes = Object.fromEntries(Object.entries(ROUTE_ENV).map(([type, keys]) => {
    const key = keys.find(name => env[name] !== undefined);
    const model = key && env[key];
    if (typeof model !== 'string' || !allowed.includes(model)) {
      throw new TypeError(`A valid model must be configured for ${type} via ${keys.join(' or ')}`);
    }
    return [type, model];
  }));
  return workType => {
    if (!Object.hasOwn(routes, workType)) throw new TypeError(`Unknown work type: ${workType}`);
    return routes[workType];
  };
}
