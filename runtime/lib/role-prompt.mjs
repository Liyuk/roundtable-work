// Role-injected instructions, assembled at launch time. Each role maps to exactly one prompt file.
import { readFile as fsReadFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROLE_FILES = new Map([
  ['chief', new URL('../../.agents/skills/roundtable-work/prompts/roles/chief.md', import.meta.url)],
  ['supervisor', new URL('../prompts/supervisor.md', import.meta.url)],
]);

/** Returns the instruction text for `role`. Unknown roles throw TypeError. */
export async function assembleRolePrompt(role, { readFile = fsReadFile } = {}) {
  if (!ROLE_FILES.has(role)) throw new TypeError(`unknown role: ${role}`);
  return readFile(fileURLToPath(ROLE_FILES.get(role)), 'utf8');
}
