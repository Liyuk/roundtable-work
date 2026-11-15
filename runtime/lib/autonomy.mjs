import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASK_CATEGORIES } from './machine.mjs';
import { safetyFiles } from './safety.mjs';

const DEFAULTS_PATH = fileURLToPath(new URL('../defaults/autonomy.json', import.meta.url));
const HOST_PATH = join(homedir(), '.config', 'rtd', 'autonomy.json');
const LIST_KEYS = ['kinds', 'silentKinds', 'silentPaths'];

// Errors name only the key or the file path, never host values or file content.
async function readHost(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  let host;
  try { host = JSON.parse(text); }
  catch { throw new Error(`Host autonomy file is not valid JSON: ${path}`); }
  if (host === null || typeof host !== 'object' || Array.isArray(host)) throw new Error(`Host autonomy file must contain a JSON object: ${path}`);
  return host;
}

// Tighten-only merge: lists intersect with the defaults, the TTL takes the minimum, and the approver may only move to owner.
// Entries the host adds beyond the defaults are ignored and listed.
export async function loadAutonomy({ defaultsPath = DEFAULTS_PATH, hostPath = HOST_PATH } = {}) {
  const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  const host = await readHost(hostPath);
  const autonomy = { ...defaults };
  const ignored = [];
  for (const [key, value] of Object.entries(host)) {
    if (LIST_KEYS.includes(key)) {
      if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw new Error(`Host autonomy list must be an array of strings: ${key}`);
      autonomy[key] = defaults[key].filter((entry) => value.includes(entry));
      ignored.push(...value.filter((entry) => !defaults[key].includes(entry)).map((entry) => `${key}:${entry}`));
    } else if (key === 'notifyTtlDays') {
      if (!Number.isFinite(value) || value < 0) throw new Error(`Host autonomy value must be a number >= 0: ${key}`);
      autonomy[key] = Math.min(defaults[key], value);
    } else if (key === 'safetyApprover') {
      if (typeof value !== 'string') throw new Error(`Host autonomy value must be a string: ${key}`);
      if (value === 'owner' && defaults[key] === 'decider') autonomy[key] = value;
      else ignored.push(key);
    } else {
      ignored.push(key);
    }
  }
  return { autonomy, ignored };
}

// Glob segments: `**` matches any depth (including zero segments), `*` matches within one segment.
const segmentMatches = (pattern, segment) => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(segment);

function matchSegments(patterns, segments) {
  if (patterns.length === 0) return segments.length === 0;
  if (patterns[0] === '**') return matchSegments(patterns.slice(1), segments) || (segments.length > 0 && matchSegments(patterns, segments.slice(1)));
  return segments.length > 0 && segmentMatches(patterns[0], segments[0]) && matchSegments(patterns.slice(1), segments.slice(1));
}

const globMatches = (path, glob) => matchSegments(glob.split('/'), path.split('/'));

const approve = (reasons) => ({ tier: 'approve-first', reasons });

/** Pure tier function: first matching rule wins. Safety files are derived from the live paths only. */
export function autonomyTier(action, autonomy) {
  const { kind, category, production, revert, revertOf, labels = [], risk, paths } = action;
  if (!autonomy.kinds.includes(kind)) return approve(['kind-not-allowed']);
  if (ASK_CATEGORIES.includes(category)) return approve([`closed-category:${category}`]);
  if (production) return approve([`production:${production}`]);
  if (revert === false) return approve(['irreversible']);
  const files = safetyFiles(paths);
  if (files.length > 0) return { ...approve(files.map((path) => `safety-file:${path}`)), approver: autonomy.safetyApprover };
  if (labels.includes('rt:tier-approve')) return approve(['owner-override']);
  if (risk === 'risk:high') return approve(['risk-high']);
  const silent = autonomy.silentKinds.includes(kind) && risk === 'risk:low' && paths.length > 0 && !revertOf &&
    paths.every((path) => autonomy.silentPaths.some((glob) => globMatches(path, glob)));
  return { tier: silent ? 'auto-silent' : 'auto-notify', reasons: [] };
}
