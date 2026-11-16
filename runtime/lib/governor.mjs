// Resource governor: caps the worker count from host load and available memory, with hysteresis.
// Pure: the sample is passed in; the file read for the defaults is the only I/O.
import { readFileSync } from 'node:fs';

const DEFAULTS_PATH = new URL('../defaults/governor.json', import.meta.url);
const HOT_CYCLES = 2; // consecutive hot cycles before one step down
const COOL_CYCLES = 3; // consecutive cool cycles before one step up
export const GAP_CLAIM_HOLD_MS = 5 * 60_000; // new claims are held this long after a cycle gap
const ADMISSION_DEFAULTS = { loadPerCpu: 1, minAvailableMiB: 2500, maxMemPsi: 10 };

/** Throws a TypeError naming the offending key of a governor config; returns the config when valid. */
export function validateGovernor(config) {
  const check = (obj, keys, prefix, optional = []) => {
    for (const key of Object.keys(obj)) if (!keys.includes(key) && !optional.includes(key)) throw new TypeError(`governor: unknown key ${prefix}${key}`);
    for (const key of keys) if (!(key in obj)) throw new TypeError(`governor: missing key ${prefix}${key}`);
  };
  check(config, ['min', 'max', 'load', 'memory'], '', ['admission']);
  check(config.load, ['high', 'low'], 'load.');
  check(config.memory, ['minRatio', 'okRatio'], 'memory.');
  if (config.admission) {
    check(config.admission, Object.keys(ADMISSION_DEFAULTS), 'admission.');
    for (const [key, value] of Object.entries(config.admission)) if (!(value > 0)) throw new TypeError(`governor: admission.${key} must be above 0`);
  }
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

/** Admission thresholds from the `admission` block of the governor config, read on each call; a missing file or invalid key takes its default. */
export function readAdmissionConfig(file = DEFAULTS_PATH) {
  let admission;
  try { admission = JSON.parse(readFileSync(file, 'utf8')).admission; } catch { admission = undefined; }
  return Object.fromEntries(Object.entries(ADMISSION_DEFAULTS).map(([key, value]) => [key, typeof admission?.[key] === 'number' && admission[key] > 0 ? admission[key] : value]));
}

/** MemAvailable in MiB from a /proc/meminfo text; undefined when missing or malformed. */
export function readMemAvailableMiB(text) {
  const kb = Number(text?.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1]);
  return kb > 0 ? kb / 1024 : undefined;
}

/** The `some avg60` value from a /proc/pressure/memory text; undefined when missing. */
export function readPsiSomeAvg60(text) {
  const value = text?.match(/^some .*avg60=([\d.]+)/m)?.[1];
  return value === undefined ? undefined : Number(value);
}

/**
 * Reasons to hold new claims: 'load' (load1 above cpus x loadPerCpu), 'memAvailable' (MiB below minAvailableMiB),
 * 'memPsi' (some avg60 above maxMemPsi). A signal with an undefined value compares false, so it does not hold.
 */
export function admissionHold({ load1, cpus, memAvailableMiB, memPsiAvg60 }, admission) {
  return [
    load1 > cpus * admission.loadPerCpu && 'load',
    memAvailableMiB < admission.minAvailableMiB && 'memAvailable',
    memPsiAvg60 > admission.maxMemPsi && 'memPsi',
  ].filter(Boolean);
}
