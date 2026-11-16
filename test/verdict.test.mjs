import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../lib/verdict.mjs';

// Legacy aliases: the Chinese words are parse-only; writers never emit them.
test('Legacy alias: 通过 (Chinese pass) maps to passed', () => {
  assert.equal(parseVerdict('通过'), 'passed');
});

test('Legacy alias: 打回 (Chinese reject) maps to rejected', () => {
  assert.equal(parseVerdict('打回'), 'rejected');
});

test('Legacy alias: 阻塞 (Chinese block) maps to blocked', () => {
  assert.equal(parseVerdict('阻塞'), 'blocked');
});

test('English form: pass (lowercase) maps to passed', () => {
  assert.equal(parseVerdict('pass'), 'passed');
});

test('English form: passed (lowercase) maps to passed', () => {
  assert.equal(parseVerdict('passed'), 'passed');
});

test('English form: PASSED (uppercase) maps to passed', () => {
  assert.equal(parseVerdict('PASSED'), 'passed');
});

test('English form: Passed (capitalized) maps to passed', () => {
  assert.equal(parseVerdict('Passed'), 'passed');
});

test('English form: reject (lowercase) maps to rejected', () => {
  assert.equal(parseVerdict('reject'), 'rejected');
});

test('English form: rejected (lowercase) maps to rejected', () => {
  assert.equal(parseVerdict('rejected'), 'rejected');
});

test('English form: REJECTED (uppercase) maps to rejected', () => {
  assert.equal(parseVerdict('REJECTED'), 'rejected');
});

test('English form: block (lowercase) maps to blocked', () => {
  assert.equal(parseVerdict('block'), 'blocked');
});

test('English form: blocked (lowercase) maps to blocked', () => {
  assert.equal(parseVerdict('blocked'), 'blocked');
});

test('English form: BLOCKED (uppercase) maps to blocked', () => {
  assert.equal(parseVerdict('BLOCKED'), 'blocked');
});

test('English alias: returned maps to rejected', () => {
  assert.equal(parseVerdict('returned'), 'rejected');
});

test('English alias: RETURNED (uppercase) maps to rejected', () => {
  assert.equal(parseVerdict('RETURNED'), 'rejected');
});

test('Whitespace handling: leading space', () => {
  assert.equal(parseVerdict('  passed'), 'passed');
});

test('Whitespace handling: trailing space', () => {
  assert.equal(parseVerdict('rejected  '), 'rejected');
});

test('Whitespace handling: leading and trailing space', () => {
  assert.equal(parseVerdict('  blocked  '), 'blocked');
});

test('Whitespace handling: newline before', () => {
  assert.equal(parseVerdict('\npassed'), 'passed');
});

test('Whitespace handling: newline after', () => {
  assert.equal(parseVerdict('rejected\n'), 'rejected');
});

test('Whitespace handling: multiple newlines and spaces', () => {
  assert.equal(parseVerdict('  \n  blocked  \n  '), 'blocked');
});

test('Legacy alias still works after the English-only switch: 通过', () => {
  assert.equal(parseVerdict('通过'), 'passed');
});

test('Legacy alias still works after the English-only switch: 打回', () => {
  assert.equal(parseVerdict('打回'), 'rejected');
});

test('Legacy alias still works after the English-only switch: 阻塞', () => {
  assert.equal(parseVerdict('阻塞'), 'blocked');
});

test('Invalid input: unrecognized string throws TypeError', () => {
  assert.throws(
    () => parseVerdict('unknown'),
    (err) => err instanceof TypeError && err.message.includes('Unrecognized verdict')
  );
});

test('Invalid input: empty string throws TypeError', () => {
  assert.throws(
    () => parseVerdict(''),
    (err) => err instanceof TypeError
  );
});

test('Invalid input: whitespace-only string throws TypeError', () => {
  assert.throws(
    () => parseVerdict('   \n   '),
    (err) => err instanceof TypeError
  );
});

test('Invalid input: wrong type (number) throws TypeError', () => {
  assert.throws(
    () => parseVerdict(123),
    (err) => err instanceof TypeError && err.message.includes('Expected string')
  );
});

test('Invalid input: wrong type (null) throws TypeError', () => {
  assert.throws(
    () => parseVerdict(null),
    (err) => err instanceof TypeError
  );
});

test('Invalid input: wrong type (undefined) throws TypeError', () => {
  assert.throws(
    () => parseVerdict(undefined),
    (err) => err instanceof TypeError
  );
});

test('Mixed case: PaSSed maps to passed', () => {
  assert.equal(parseVerdict('PaSSed'), 'passed');
});

test('Mixed case: ReTuRnEd maps to rejected', () => {
  assert.equal(parseVerdict('ReTuRnEd'), 'rejected');
});

test('Error message is clear for invalid input', () => {
  const invalidInput = 'bad_verdict';
  try {
    parseVerdict(invalidInput);
    assert.fail('Should have thrown TypeError');
  } catch (err) {
    assert.ok(err instanceof TypeError);
    assert.ok(err.message.includes('Unrecognized verdict'));
    assert.ok(err.message.includes(invalidInput));
  }
});

test('English writer words: pass, reject, block map to the normalized forms', () => {
  assert.equal(parseVerdict('pass'), 'passed');
  assert.equal(parseVerdict('Reject'), 'rejected');
  assert.equal(parseVerdict('BLOCK'), 'blocked');
});
