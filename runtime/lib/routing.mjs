import { readFile } from 'node:fs/promises';

export const ROLES = ['chief', 'developer', 'fixer', 'reviewer', 'researcher', 'crosscheck'];
export const TIERS = ['economy', 'standard', 'strong'];

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

/** Validate the single role-to-model routing table and return it unchanged. */
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
    for (const role of ROLES) if (!(role in roles)) fail(`window "${window.id}" is missing role "${role}"`);
    for (const role of Object.keys(roles)) if (!ROLES.includes(role)) fail(`window "${window.id}" has unknown role "${role}"`);

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
