import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfigLayers } from './config-layers.mjs';
import { satisfies } from './semver.mjs';

// The installed version is the package.json of the checkout that contains this runtime.
const PACKAGE_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const INSTALLED_VERSION = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8')).version;

/** Pure: a null range is ok; otherwise the installed version must satisfy it. */
export function checkVersionPin(range, installed) {
  if (range === null) return { ok: true, message: 'no requiredVersionRange set' };
  const ok = satisfies(range, installed);
  const verdict = ok ? 'satisfies' : 'does not satisfy';
  return { ok, message: `installed version ${installed} ${verdict} requiredVersionRange ${range}` };
}

/** Reads the project pin through the layered limits config for the workspace (the parent of `.roundtable/`). */
export async function checkWorkspacePin(workspace) {
  const { values } = await loadConfigLayers({ name: 'limits', workspace });
  return checkVersionPin(values.requiredVersionRange, INSTALLED_VERSION);
}

// CLI for bin/rtd: `node version-pin.mjs <workspace>` prints the pin check as JSON.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await checkWorkspacePin(process.argv[2])));
}
