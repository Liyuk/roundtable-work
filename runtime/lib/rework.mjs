/** A role is configured when its routing entry names both a harness and a model. */
const configured = (roles, role) => typeof roles?.[role]?.harness === 'string' && roles[role].harness !== ''
  && typeof roles[role].model === 'string' && roles[role].model !== '';

/**
 * Pick the role that implements a developing phase. Rework goes to `fixer` when configured, otherwise to `developer`.
 * Never `chief`: returns `{ stop: 'no_implementer_configured' }` when neither is configured.
 */
export function implementerRole({ routing, rework }) {
  // Library callers may run without routing facts (the CLI always supplies them): the developer role is then unchanged.
  if (routing === undefined) return 'developer';
  const roles = routing.facts?.roles;
  if (rework && configured(roles, 'fixer')) return 'fixer';
  if (configured(roles, 'developer')) return 'developer';
  return { stop: 'no_implementer_configured' };
}

/** A development result authored by Chief is a fail-closed scope mismatch unless the policy allows Chief to implement. */
export function chiefAuthored({ author, chiefImplements }) {
  return author === 'chief' && chiefImplements !== true;
}
