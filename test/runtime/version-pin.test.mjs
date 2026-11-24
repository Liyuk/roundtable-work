import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVersionPin } from '../../runtime/lib/version-pin.mjs';

// Seam: checkVersionPin(range, installed) -> { ok, message }. Pure: the installed version is passed in.
test('a null range is ok for any installed version', () => {
  assert.equal(checkVersionPin(null, '0.2.2').ok, true);
});

test('an installed version inside the range is ok', () => {
  const r = checkVersionPin('>=0.2.0 <0.3.0', '0.2.2');
  assert.equal(r.ok, true);
});

test('an installed version outside the range fails and the message names the range and the installed version', () => {
  const r = checkVersionPin('>=0.3.0', '0.2.2');
  assert.equal(r.ok, false);
  assert.match(r.message, />=0\.3\.0/);
  assert.match(r.message, /0\.2\.2/);
});
