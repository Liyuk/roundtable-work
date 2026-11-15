import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, createAdapterLauncher } from './agent-adapter.mjs';
import { ROLES } from './routing.mjs';

export const HARNESS_CONFIG = fileURLToPath(new URL('../harness.config.json', import.meta.url));

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
  for (const role of ROLES) selectHarness(config.roles[role]);
  return config;
}

/** Launcher for the implementer role: its configured harness, and the model routed to that role. */
export function implementerLaunch({ config, facts, command, spawnFn, env }) {
  const role = config.implementerRole;
  const launch = createAdapterLauncher({ adapter: selectHarness(config.roles[role]), command, spawnFn, env });
  return { launch, model: facts.roles[role].model };
}
