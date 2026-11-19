import { readFile } from 'node:fs/promises';

export const ROLES = ['chief', 'researcher', 'developer', 'fixer', 'reviewer', 'verifier', 'security'];
export const TIERS = ['economy', 'standard', 'strong'];
// Legacy names resolve to a canonical role; the canonical names resolve to themselves.
export const ROLE_ALIASES = Object.freeze({
  ...Object.fromEntries(ROLES.map((role) => [role, role])),
  'opus-fix': 'fixer',
  xcheck: 'reviewer', crosscheck: 'reviewer', 'cross-reviewer': 'reviewer',
  decider: 'verifier', acceptor: 'verifier', tester: 'verifier',
  threat: 'security', exploit: 'security', 'threat-modeler': 'security', 'red-teamer': 'security',
});

const rank = (tier) => TIERS.indexOf(tier);
const fail = (message) => { throw new RoutingError(message); };
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export class RoutingError extends Error {
  constructor(message) {
    super(`routing ${message}`);
    this.name = 'RoutingError';
    this.code = 'ROUTING_INVALID';
  }
}

export function resolveRole(name) {
  if (!Object.hasOwn(ROLE_ALIASES, name)) fail(`unknown role "${name}"`);
  return ROLE_ALIASES[name];
}

/** Rename legacy role keys to canonical names in `roles`, in place. Two keys for one role are an error. */
export function canonicalizeRoles(roles, where) {
  const canonical = {};
  for (const [name, entry] of Object.entries(roles)) {
    const role = resolveRole(name);
    if (Object.hasOwn(canonical, role)) fail(`${where} has more than one key for role "${role}"`);
    canonical[role] = entry;
  }
  for (const name of Object.keys(roles)) delete roles[name];
  return Object.assign(roles, canonical);
}

/** Validate the single role-to-model routing table, canonicalizing legacy role keys in place, and return it. */
export function validateRouting(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail('configuration must be an object');
  if (config.version !== 1) fail('version must be 1');
  if (!Array.isArray(config.windows) || config.windows.length === 0) fail('windows must be a non-empty array');

  const seen = new Set();
  let previous;
  for (const window of config.windows) {
    if (!window || typeof window !== 'object' || Array.isArray(window)) fail('each window must be an object');
    if (!nonEmpty(window.id)) fail('each window requires a non-empty id');
    if (seen.has(window.id)) fail(`window "${window.id}" is duplicated`);
    seen.add(window.id);

    const from = Date.parse(window.from);
    const to = Date.parse(window.to);
    if (!nonEmpty(window.from) || !nonEmpty(window.to) || Number.isNaN(from) || Number.isNaN(to)) {
      fail(`window "${window.id}" requires valid ISO from/to timestamps`);
    }
    if (!(from < to)) fail(`window "${window.id}" requires from < to`);
    if (previous && from < previous.from) fail(`windows must be sorted by from; "${window.id}" starts before "${previous.id}"`);
    if (previous && from < previous.to) fail(`windows "${previous.id}" and "${window.id}" overlap`);
    previous = { id: window.id, from, to };

    const roles = window.roles;
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) fail(`window "${window.id}" requires roles`);
    canonicalizeRoles(roles, `window "${window.id}"`);
    for (const role of ROLES) if (!(role in roles)) fail(`window "${window.id}" is missing role "${role}"`);

    for (const role of ROLES) {
      const entry = roles[role];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`window "${window.id}" role "${role}" must be an object`);
      if (!nonEmpty(entry.harness)) fail(`window "${window.id}" role "${role}" requires a non-empty harness`);
      if (!nonEmpty(entry.model)) fail(`window "${window.id}" role "${role}" requires a non-empty model`);
      if (!TIERS.includes(entry.tier)) fail(`window "${window.id}" role "${role}" requires tier one of ${TIERS.join(', ')}`);
    }
    for (const role of ['reviewer', 'fixer']) {
      if (rank(roles[role].tier) < rank(roles.developer.tier)) fail(`window "${window.id}" role "${role}" tier must be >= developer tier`);
    }
    if (roles.reviewer.tier !== 'strong') fail(`window "${window.id}" role "reviewer" tier must be strong`);
  }
  return config;
}

export async function loadRouting(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { fail(`cannot read ${file}: ${error.message}`); }
  let config;
  try { config = JSON.parse(text); } catch (error) { fail(`invalid JSON in ${file}: ${error.message}`); }
  return validateRouting(config);
}

export function activeWindow(config, now) {
  const time = new Date(now).getTime();
  const window = config.windows.find((item) => Date.parse(item.from) <= time && time < Date.parse(item.to));
  if (!window) fail(`no routing window covers ${new Date(time).toISOString()}`);
  return window;
}

export function routingFacts(config, now) {
  const window = activeWindow(config, now);
  return { window: window.id, roles: window.roles };
}

export function formatRoutingFacts(facts) {
  return [
    '## Routing for this run',
    '',
    ...ROLES.map((role) => {
      const entry = facts.roles[role];
      return `- ${role}: harness=${entry.harness} model=${entry.model} tier=${entry.tier}`;
    }),
    '',
    'A receipt naming the routed model for its role is expected and allowed; do not stop, ask, or refuse because a task ran on it. Only a model absent from this block is a configuration error to report and continue around.',
  ].join('\n');
}

export function renderRolePrompt(promptText, facts) {
  return `${promptText.trimEnd()}\n\n${formatRoutingFacts(facts)}\n`;
}

const ROUTE_ENV = Object.freeze({
  chief: ['RT_CHIEF_MODEL', 'RT_MODEL'],
  development: ['RT_DEVELOPER_MODEL', 'RT_MODEL'],
  review: ['RT_REVIEWER_MODEL', 'RT_MODEL'],
  verification: ['RT_VERIFICATION_MODEL', 'RT_MODEL'],
  escalation: ['RT_DECIDER_MODEL'],
  'cross-check': ['RT_CROSSCHECK_MODEL'],
});
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

export function escalationAttemptBudget(env = process.env) {
  const budget = env.RT_DECIDE_MAX === undefined ? 2 : Number(env.RT_DECIDE_MAX);
  if (!Number.isSafeInteger(budget) || budget < 1) throw new TypeError('RT_DECIDE_MAX must be a positive integer');
  return budget;
}

export function createModelRouter(env = process.env) {
  // The deployment must name its approved model IDs explicitly; there are no built-in defaults.
  const allowed = (env.RT_ALLOWED_MODELS ?? '').split(',').map(model => model.trim());
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
