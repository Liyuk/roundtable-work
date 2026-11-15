import { readFile } from 'node:fs/promises';

/** Ledger entry type for a passing local check; the id is `local-check:<head>`, so a record only ever covers one head. */
export const LOCAL_CHECK = 'local_check';
const DEFAULT_CONFIG = new URL('../local-checks.config.json', import.meta.url);

/** Load the local-check config; a missing file, a non-boolean `enabled`, or an empty `command` throws (fail closed). */
export async function loadLocalChecksConfig(path = DEFAULT_CONFIG) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  if (typeof config.enabled !== 'boolean') throw new TypeError('local-checks config: enabled must be a boolean');
  if (typeof config.command !== 'string' || !config.command.trim()) throw new TypeError('local-checks config: command must be a non-empty string');
  return config;
}

/** Pure: the ledger entry recording a passing local check for one head and tree. */
export const localCheckEntry = ({ head, tree, command }) => ({ id: `local-check:${head}`, type: LOCAL_CHECK, detail: { head, tree, command, ok: true } });

/** Pure: whether the ledger holds a passing local check recorded for exactly this head. */
export const localCheckPasses = (ledger, head) => ledger.some((entry) => entry.type === LOCAL_CHECK && entry.detail?.head === head && entry.detail?.ok === true && entry.id === `local-check:${head}`);

/** Pure: whether required CI allows a merge; absent CI passes only through an enabled, recorded local check for this head. */
export const ciAllowsMerge = ({ checks, enabled, ledger, head }) =>
  checks === true || checks?.green === true || (enabled === true && checks?.status === 'absent' && localCheckPasses(ledger, head));
