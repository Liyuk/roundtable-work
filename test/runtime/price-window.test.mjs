import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePriceWindow, validatePriceWindows } from '../../runtime/lib/price-window.mjs';

// Seam: validatePriceWindows(config) and evaluatePriceWindow(config, { harness, model, now }).
// Fixed instants: 2026-11-16 is a Monday, 2026-11-14 a Saturday (UTC).
const config = {
  holidayTimeZone: 'UTC',
  holidays: ['2026-11-26'],
  entries: {
    'pi/a': { timeZone: 'UTC', windows: [{ days: ['Mon', 'Tue'], start: '09:00', end: '17:00' }] },
    'codex/b': { timeZone: 'Asia/Shanghai', windows: [{ start: '01:00', end: '02:00' }] },
  },
};
const at = (iso) => new Date(iso);
const check = (cfg, harness, model, iso) => evaluatePriceWindow(cfg, { harness, model, now: at(iso) });

test('inside a configured window the gate is open; outside it is closed', () => {
  assert.equal(check(config, 'pi', 'a', '2026-11-16T10:00:00Z').open, true);
  assert.equal(check(config, 'pi', 'a', '2026-11-16T17:00:00Z').open, false);
  assert.equal(check(config, 'pi', 'a', '2026-11-16T08:59:00Z').open, false);
  assert.equal(check(config, 'pi', 'a', '2026-11-18T10:00:00Z').open, false, 'Wednesday is not in days');
});

test('a configured holiday is open for the whole day, even outside windows', () => {
  assert.deepEqual(check(config, 'pi', 'a', '2026-11-26T03:00:00Z'), { open: true, reason: 'holiday' });
  assert.equal(check(config, 'pi', 'a', '2026-11-26T23:59:00Z').open, true);
});

test('entries with different windows and zones are evaluated independently', () => {
  // 2026-11-16T10:00Z is 18:00 Shanghai: pi/a open (09-17 UTC is 10:00 UTC), codex/b closed.
  assert.equal(check(config, 'pi', 'a', '2026-11-16T10:00:00Z').open, true);
  assert.equal(check(config, 'codex', 'b', '2026-11-16T10:00:00Z').open, false);
  // 2026-11-16T17:30Z is 01:30 Shanghai: codex/b open, pi/a closed.
  assert.equal(check(config, 'codex', 'b', '2026-11-16T17:30:00Z').open, true);
  assert.equal(check(config, 'pi', 'a', '2026-11-16T17:30:00Z').open, false);
});

test('unknown key and missing config fail closed', () => {
  assert.deepEqual(check(config, 'pi', 'zzz', '2026-11-16T10:00:00Z'), { open: false, reason: 'unknown' });
  assert.deepEqual(check(config, 'codex', 'a', '2026-11-16T10:00:00Z'), { open: false, reason: 'unknown' });
  assert.deepEqual(check(null, 'pi', 'a', '2026-11-16T10:00:00Z'), { open: false, reason: 'no-config' });
  assert.deepEqual(evaluatePriceWindow(undefined, { harness: 'pi', model: 'a', now: at('2026-11-16T10:00:00Z') }), { open: false, reason: 'no-config' });
});

test('invalid config is rejected naming only the key path, never the value', () => {
  const secret = 'SECRET-VALUE-42';
  const bad = [
    [{ holidayTimeZone: 'UTC', entries: { 'pi/a': { timeZone: 'UTC', windows: [{ start: '9:00', end: '17:00' }] } } }, 'entries.pi/a.windows[0].start'],
    [{ holidayTimeZone: 'UTC', entries: { 'pi/a': { timeZone: 'UTC', windows: [{ start: '17:00', end: '09:00' }] } } }, 'entries.pi/a.windows[0]'],
    [{ holidayTimeZone: 'UTC', entries: { 'pi/a': { timeZone: 'UTC', windows: [{ days: ['Funday'], start: '09:00', end: '10:00' }] } } }, 'entries.pi/a.windows[0].days'],
    [{ holidayTimeZone: 'UTC', holidays: ['2026-13-40'], entries: {} }, 'holidays[0]'],
    [{ holidayTimeZone: 'Not/AZone', entries: {} }, 'holidayTimeZone'],
    [{ holidayTimeZone: 'UTC', entries: { 'pi/a': { timeZone: 'Bad/Zone', windows: [] } } }, 'entries.pi/a.timeZone'],
    [{ holidayTimeZone: 'UTC', entries: {}, extra: secret }, 'extra'],
    [{ holidayTimeZone: 'UTC', entries: { 'pi/a': { timeZone: 'UTC', windows: [], bogus: 1 } } }, 'entries.pi/a.bogus'],
  ];
  for (const [cfg, path] of bad) {
    assert.throws(() => validatePriceWindows(cfg), (err) => err.message.includes(path) && !err.message.includes(secret));
  }
  assert.throws(() => validatePriceWindows({ holidayTimeZone: 'UTC', entries: {}, extra: secret }), (err) => !err.message.includes(secret));
});

test('a valid config is returned validated and defaults holidays to none', () => {
  const out = validatePriceWindows({ holidayTimeZone: 'UTC', entries: {} });
  assert.deepEqual(out.holidays, []);
  assert.deepEqual(validatePriceWindows(config), config);
});
