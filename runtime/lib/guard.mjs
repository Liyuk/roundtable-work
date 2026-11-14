import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePriceWindows } from './price-window.mjs';

const DEFAULTS_PATH = fileURLToPath(new URL('../defaults/limits.json', import.meta.url));
const HOST_PATH = join(homedir(), '.config', 'rtd', 'limits.json');

// Errors name only the key or the file path, never host values or file content.
async function readHost(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  let host;
  try { host = JSON.parse(text); }
  catch { throw new Error(`Host limits file is not valid JSON: ${path}`); }
  if (host === null || typeof host !== 'object' || Array.isArray(host)) throw new Error(`Host limits file must contain a JSON object: ${path}`);
  return host;
}

// Tighten-only merge: host values may only be stricter than the repo defaults.
// Numbers are caps (min wins); booleans are permissions (default && host).
export async function loadLimits({ defaultsPath = DEFAULTS_PATH, hostPath = HOST_PATH } = {}) {
  const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  const host = await readHost(hostPath);
  const limits = { ...defaults };
  const clamped = [];
  const { priceWindows: rawWindows, ...rest } = host;
  const priceWindows = rawWindows === undefined ? null : validatePriceWindows(rawWindows);
  for (const [key, value] of Object.entries(rest)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown host limit key: ${key}`);
    const base = defaults[key];
    if (typeof base === 'boolean') {
      if (typeof value !== 'boolean') throw new Error(`Host limit has the wrong type: ${key}`);
      limits[key] = base && value;
      if (value && !base) clamped.push(key);
    } else {
      if (typeof value !== 'number' || value < 0) throw new Error(`Host limit must be a number >= 0: ${key}`);
      limits[key] = Math.min(base, value);
      if (value > base) clamped.push(key);
    }
  }
  return { limits, clamped: clamped.sort(), priceWindows };
}
