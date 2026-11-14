// Price windows: host-only gate deciding whether a harness/model may spend metered tokens now.
// Windows are half-open [start, end) on one local day; overnight spans are two windows.
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ROOT = 'priceWindows';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const mins = (t) => t.split(':').reduce((h, m) => h * 60 + Number(m), 0);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isZone = (v) => {
  if (typeof v !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; }
};

// Errors name only the key path, never the configured value.
function checkKeys(obj, allowed, path) {
  if (!isObject(obj)) throw new Error(`Invalid price window config: ${path}`);
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw new Error(`Invalid price window config: ${path}.${key}`);
  }
}

function fail(path) { throw new Error(`Invalid price window config: ${path}`); }

function validateWindow(w, path) {
  checkKeys(w, ['days', 'start', 'end'], path);
  if (w.days !== undefined && (!Array.isArray(w.days) || !w.days.every((d) => DAYS.includes(d)))) fail(`${path}.days`);
  if (typeof w.start !== 'string' || !TIME.test(w.start)) fail(`${path}.start`);
  if (typeof w.end !== 'string' || !TIME.test(w.end)) fail(`${path}.end`);
  if (mins(w.start) >= mins(w.end)) fail(path);
}

function validateEntry(entry, path) {
  checkKeys(entry, ['timeZone', 'windows'], path);
  if (!isZone(entry.timeZone)) fail(`${path}.timeZone`);
  if (!Array.isArray(entry.windows)) fail(`${path}.windows`);
  entry.windows.forEach((w, i) => validateWindow(w, `${path}.windows[${i}]`));
}

export function validatePriceWindows(config) {
  checkKeys(config, ['holidayTimeZone', 'holidays', 'entries'], ROOT);
  if (!isZone(config.holidayTimeZone)) fail(`${ROOT}.holidayTimeZone`);
  const holidays = config.holidays ?? [];
  if (!Array.isArray(holidays)) fail(`${ROOT}.holidays`);
  holidays.forEach((d, i) => { if (!isDate(d)) fail(`${ROOT}.holidays[${i}]`); });
  if (!isObject(config.entries)) fail(`${ROOT}.entries`);
  for (const [name, entry] of Object.entries(config.entries)) validateEntry(entry, `${ROOT}.entries.${name}`);
  return { ...config, holidays };
}

// Local calendar date, weekday and minute-of-day of `now` in `timeZone`.
function local(timeZone, now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, minute: mins(`${p.hour}:${p.minute}`) };
}

// Fail closed: anything not provably inside a window or holiday is closed.
export function evaluatePriceWindow(config, { harness, model, now }) {
  if (!config) return { open: false, reason: 'no-config' };
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) return { open: false, reason: 'bad-time' };
  const entry = config.entries[`${harness}/${model}`];
  if (!entry) return { open: false, reason: 'unknown' };
  if (config.holidays.includes(local(config.holidayTimeZone, now).date)) return { open: true, reason: 'holiday' };
  const here = local(entry.timeZone, now);
  const hit = entry.windows.some((w) => (!w.days || w.days.includes(here.weekday))
    && mins(w.start) <= here.minute && here.minute < mins(w.end));
  return hit ? { open: true, reason: 'window' } : { open: false, reason: 'outside-window' };
}
