// Pre-dispatch preflight for implementer cards (ticket 84, #71). Checks run in order and stop at the first failure.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const fail = (reason, detail) => ({ ok: false, reason, ...(detail === undefined ? {} : { detail }) });
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

/**
 * Checks an implementer card before dispatch. Returns `{ ok: true }` or `{ ok: false, reason, detail? }`.
 * `card`: { conventions?: string[], baseline?: string, keyNumbers?: object }; `source`: { keyNumbers };
 * `baseline`: { expected } (the current `MAJOR.MINOR.PATCH`). `exec(command, { cwd })` resolves `{ exitCode, stderr }`
 * and is supplied by the caller (this module never spawns processes).
 */
export async function runPreDispatch({ card, worktree, source, baseline, exec, prepare = 'npm ci', tmpDir = tmpdir() }) {
  // 1. Convention files exist and resolve (through symlinks) inside the worktree.
  const root = await realpath(worktree);
  for (const name of card.conventions ?? []) {
    let real;
    try { real = await realpath(resolve(root, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; return fail(`missing_convention_file:${name}`); }
    if (!inside(root, real)) return fail(`convention_outside_worktree:${name}`);
  }
  // 2. Baseline is present, well formed and equal to the expected version.
  if (!/^\d+\.\d+\.\d+$/.test(card.baseline ?? '')) return fail('baseline_invalid');
  if (card.baseline !== baseline.expected) return fail('baseline_stale');
  // 3. Key numbers match the source exactly, with no unknown keys.
  const numbers = card.keyNumbers ?? {};
  const sourceNumbers = source.keyNumbers;
  const keys = new Set([...Object.keys(numbers), ...Object.keys(sourceNumbers)]);
  for (const key of keys) if (numbers[key] !== sourceNumbers[key]) return fail('numbers_mismatch', key);
  // 4. Environment: the prepare command succeeds and a temp directory is writable.
  const prepared = await exec(prepare, { cwd: worktree });
  if (prepared.exitCode !== 0) return fail('environment_not_ready', prepared.stderr.slice(-2000));
  try { await rm(await mkdtemp(join(tmpDir, 'rt-preflight-')), { recursive: true }); } catch (error) { return fail('environment_not_ready', error.message); }
  return { ok: true };
}
