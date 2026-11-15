// Resource governor: caps the worker count from host load and available memory, with hysteresis.
// Pure: the sample is passed in; the file read for the defaults is the only I/O.
import { readFileSync } from 'node:fs';

const DEFAULTS_PATH = new URL('../defaults/governor.json', import.meta.url);
const HOT_CYCLES = 2; // consecutive hot cycles before one step down
const COOL_CYCLES = 3; // consecutive cool cycles before one step up

/** Throws a TypeError naming the offending key of a governor config; returns the config when valid. */
export function validateGovernor(config) {
  const check = (obj, keys, prefix) => {
    for (const key of Object.keys(obj)) if (!keys.includes(key)) throw new TypeError(`governor: unknown key ${prefix}${key}`);
    for (const key of keys) if (!(key in obj)) throw new TypeError(`governor: missing key ${prefix}${key}`);
  };
  check(config, ['min', 'max', 'load', 'memory'], '');
  check(config.load, ['high', 'low'], 'load.');
  check(config.memory, ['minRatio', 'okRatio'], 'memory.');
  if (config.load.low >= config.load.high) throw new TypeError('governor: load.low must be below load.high');
  if (config.memory.minRatio >= config.memory.okRatio) throw new TypeError('governor: memory.minRatio must be below memory.okRatio');
  if (config.min > config.max) throw new TypeError('governor: min must not exceed max');
  return config;
}

/** Defaults from runtime/defaults/governor.json. */
export const governorDefaults = validateGovernor(JSON.parse(readFileSync(DEFAULTS_PATH, 'utf8')));

/** Hysteresis cap: `step(sample)` takes { load1, cpus, memAvailableRatio } and returns the cap, starting at `max`. */
export function createGovernor({ min, max, load, memory }) {
  let cap = max, hot = 0, cool = 0;
  return {
    step({ load1, cpus, memAvailableRatio }) {
      const ratio = load1 / cpus;
      const isHot = ratio > load.high || memAvailableRatio < memory.minRatio;
      const isCool = ratio < load.low && memAvailableRatio > memory.okRatio;
      hot = isHot ? hot + 1 : 0;
      cool = isCool ? cool + 1 : 0;
      if (hot >= HOT_CYCLES) { cap = Math.max(min, cap - 1); hot = cool = 0; }
      else if (cool >= COOL_CYCLES) { cap = Math.min(max, cap + 1); hot = cool = 0; }
      return cap;
    },
  };
}

/** MemAvailable / MemTotal from a /proc/meminfo text; `fallback` when either value is missing or malformed. */
export function readMemAvailableRatio(text, fallback) {
  const kb = (key) => Number(text?.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'))?.[1]);
  const available = kb('MemAvailable'), total = kb('MemTotal');
  return available > 0 && total > 0 ? available / total : fallback;
}
