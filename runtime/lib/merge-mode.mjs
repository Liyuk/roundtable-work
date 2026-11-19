import { readFile as readDiskFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MERGE_MODES = ['agent', 'owner', 'dry-run'];

/** Reads `runtime/merge.config.json`. Anything missing, unreadable, malformed, or unknown resolves to `dry-run`. */
export async function readMergeConfig({ readFile = readDiskFile, repoRoot = join(import.meta.dirname, '../..') } = {}) {
  try {
    const mode = JSON.parse(await readFile(join(repoRoot, 'runtime', 'merge.config.json'), 'utf8')).mergeMode;
    if (MERGE_MODES.includes(mode)) return mode;
  } catch {}
  return 'dry-run';
}

/** Merge-time tiers (#604) are on only when `runtime/merge.config.json` sets `mergeTiers` to exactly `true`; anything else is off. */
export async function readMergeTiers({ readFile = readDiskFile, repoRoot = join(import.meta.dirname, '../..') } = {}) {
  try {
    return JSON.parse(await readFile(join(repoRoot, 'runtime', 'merge.config.json'), 'utf8')).mergeTiers === true;
  } catch {
    return false;
  }
}
