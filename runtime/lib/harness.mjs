import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, createAdapterLauncher } from './agent-adapter.mjs';
import { ROLES, canonicalizeRoles, routingFacts } from './routing.mjs';
import { recordUsageRow } from './usage-ledger.mjs';

export const HARNESS_CONFIG = fileURLToPath(new URL('../harness.config.json', import.meta.url));
// Workspace-relative file where install writes the per-role candidate table.
export const CANDIDATES_FILE = join('.roundtable', 'harness-candidates.json');

// One harness per agent runtime. Each declares what it can do and how it is invoked; `buildArgs` returns the process
// arguments (or null when nothing is spawned). Existing ADAPTERS args are reused, so pi/codex invocations are unchanged.
// pi: a separate `pi -p` process is a different session from the caller, so subSession is false.
// codex: `codex exec` is likewise a separate process, so subSession is false.
// host-agent: runs in-process inside the host, spawns nothing, so it is never launched by createAdapterLauncher.
export const HARNESSES = Object.freeze({
  pi: Object.freeze({ name: 'pi', capabilities: Object.freeze({ subSession: false, writeFiles: true, invocation: 'bash-wrapped' }), buildArgs: ADAPTERS.pi.buildArgs }),
  codex: Object.freeze({ name: 'codex', capabilities: Object.freeze({ subSession: false, writeFiles: true, invocation: 'exec' }), buildArgs: ADAPTERS.codex.buildArgs }),
  'host-agent': Object.freeze({ name: 'host-agent', capabilities: Object.freeze({ subSession: true, writeFiles: true, invocation: 'in-process' }), buildArgs: () => null }),
});

export function selectHarness(name) {
  if (!Object.hasOwn(HARNESSES, name)) throw new Error(`unknown harness: ${name}`);
  return HARNESSES[name];
}

/** Reads the in-repo harness config. Every role's harness name must be a known harness; an unknown name throws. */
export async function loadHarnessConfig(file = HARNESS_CONFIG, read = readFile) {
  const config = JSON.parse(await read(file, 'utf8'));
  canonicalizeRoles(config.roles, 'harness config');
  for (const role of ROLES) selectHarness(config.roles[role]);
  return config;
}

/** Launcher for the implementer role: its configured harness, and the model routed to that role. Usage goes to `workRoot` when given. */
export function implementerLaunch({ config, facts, command, spawnFn, env, workRoot }) {
  const role = config.implementerRole;
  const recordUsage = workRoot && ((row) => recordUsageRow(workRoot, row));
  const launch = createAdapterLauncher({ adapter: selectHarness(config.roles[role]), command, spawnFn, env, recordUsage });
  return { launch, model: facts.roles[role].model };
}

const authorizedModels = (routing) => new Set(routing.windows.flatMap((window) => ROLES.map((role) => window.roles[role].model)));

/** Ordered candidates per role: the configured harness with the routed model, then the host agent's routed model last. */
export function buildCandidates({ config, routing, now }) {
  const facts = routingFacts(routing, now);
  const host = ROLES.map((role) => facts.roles[role]).find((entry) => entry.harness === 'host-agent');
  return Object.fromEntries(ROLES.map((role) => {
    const list = [{ harness: config.roles[role], model: facts.roles[role].model }];
    if (host && (list.at(-1).harness !== 'host-agent' || list.at(-1).model !== host.model)) list.push({ harness: 'host-agent', model: host.model });
    return [role, list];
  }));
}

/** Drop denied models from every role. A role left with no candidates is an error. */
export function applyDeny(candidates, deny) {
  return Object.fromEntries(Object.entries(candidates).map(([role, list]) => {
    const kept = list.filter((entry) => !deny.includes(entry.model));
    if (!kept.length) throw new Error(`candidates for role "${role}" have no entries left after the deny list`);
    return [role, kept];
  }));
}

/** Load-time check: every role has a non-empty list of known, authorized, non-denied candidates. */
export function validateCandidates(table, { routing, deny = [] }) {
  const authorized = authorizedModels(routing);
  for (const role of ROLES) {
    const list = table.roles?.[role];
    if (!Array.isArray(list) || list.length === 0) throw new Error(`candidates for role "${role}" are empty`);
    for (const entry of list) {
      if (!Object.hasOwn(HARNESSES, entry.harness)) throw new Error(`candidates for role "${role}" have unknown harness "${entry.harness}"`);
      if (!authorized.has(entry.model)) throw new Error(`candidates for role "${role}" use model "${entry.model}" which is not authorized by the routing table`);
      if (deny.includes(entry.model)) throw new Error(`candidates for role "${role}" use model "${entry.model}" which is on the deny list`);
    }
  }
  return table;
}
