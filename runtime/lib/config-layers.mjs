// Layered config: built-in defaults < global (~/.config/rtd/<name>.json) < project (<workspace>/.roundtable/<name>.json).
// Every key is tighten-only: an upper layer may only be stricter than the value below it. Rules per key:
//   min    number cap: the lowest value wins
//   and    boolean permission: stays on only if every layer keeps it on
//   subset array: intersects with the lower layer; entries the upper layer adds are rejected
// Looser or unknown upper-layer entries are dropped and listed in `rejected` (reason only, never the value).
// A default key with no rule fails the load. Layer files are untrusted: wrong types fail the load.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULES = {
  limits: {
    maxConcurrentWorkers: 'min', maxDecideCallsPerIssue: 'min', maxFixRoundsPerIssue: 'min', maxAttemptsPerAssignment: 'min',
    maxWakeupsPerIssue: 'min', maxReviewRoundsPerIssue: 'min', maxSessionMinutes: 'min', allowAutoFollowups: 'and',
  },
};

const typeError = (layer, key) => new Error(`Config ${layer} value has the wrong type: ${key}`);

function applyRule(rule, lower, value, layer, key) {
  if (rule === 'min') {
    if (typeof value !== 'number' || value < 0) throw typeError(layer, key);
    return value > lower ? { reason: 'looser than lower layer' } : { next: value };
  }
  if (rule === 'and') {
    if (typeof value !== 'boolean') throw typeError(layer, key);
    return value && !lower ? { reason: 'looser than lower layer' } : { next: lower && value };
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) throw typeError(layer, key);
  const extra = value.filter((entry) => !lower.includes(entry)).length;
  return { next: lower.filter((entry) => value.includes(entry)), reason: extra ? `${extra} entries not in lower layer` : null };
}

/** Pure merge: defaults, then each layer in order. Returns { values, sources, rejected }. */
function mergeLayers(defaults, rules, layers) {
  for (const key of Object.keys(defaults)) if (!rules[key]) throw new Error(`Config key has no tighten-only rule: ${key}`);
  const values = { ...defaults };
  const sources = Object.fromEntries(Object.keys(defaults).map((key) => [key, 'defaults']));
  const rejected = [];
  for (const { name, values: layer } of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (!Object.hasOwn(defaults, key)) {
        rejected.push({ layer: name, key, reason: 'unknown key' });
        continue;
      }
      const { next, reason } = applyRule(rules[key], values[key], value, name, key);
      if (reason) rejected.push({ layer: name, key, reason });
      if (next !== undefined) {
        values[key] = next;
        sources[key] = name;
      }
    }
  }
  return { values, sources, rejected };
}

// Errors name only the key or the file path, never file content.
async function readLayer(path) {
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  let layer;
  try { layer = JSON.parse(text); }
  catch { throw new Error(`Config file is not valid JSON: ${path}`); }
  if (layer === null || typeof layer !== 'object' || Array.isArray(layer)) throw new Error(`Config file must contain a JSON object: ${path}`);
  return layer;
}

export async function loadConfigLayers({
  name,
  workspace,
  rules = RULES[name],
  defaultsPath = fileURLToPath(new URL(`../defaults/${name}.json`, import.meta.url)),
  globalPath = join(homedir(), '.config', 'rtd', `${name}.json`),
}) {
  const defaults = JSON.parse(await readFile(defaultsPath, 'utf8'));
  const global = await readLayer(globalPath);
  const project = await readLayer(join(workspace, '.roundtable', `${name}.json`));
  return mergeLayers(defaults, rules, [{ name: 'global', values: global }, { name: 'project', values: project }]);
}

// CLI for bin/rtd: `node config-layers.mjs <workspace>` prints the limits layers as JSON.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(JSON.stringify(await loadConfigLayers({ name: 'limits', workspace: process.argv[2] })));
}
