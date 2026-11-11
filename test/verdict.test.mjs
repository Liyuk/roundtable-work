import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict } from '../lib/verdict.mjs';

test('Chinese form: 通过 maps to passed', () => {
  assert.equal(parseVerdict('通过'), 'passed');
});

test('Chinese form: 打回 maps to rejected', () => {
  assert.equal(parseVerdict('打回'), 'rejected');
});

test('Chinese form: 阻塞 maps to blocked', () => {
  assert.equal(parseVerdict('阻塞'), 'blocked');
});

test('English form: passed (lowercase)', () => {
  assert.equal(parseVerdict('passed'), 'passed');
});

test('English form: PASSED (uppercase)', () => {
  assert.equal(parseVerdict('PASSED'), 'passed');
});

test('English form: Passed (capitalized)', () => {
  assert.equal(parseVerdict('Passed'), 'passed');
});

test('English form: rejected (lowercase)', () => {
  assert.equal(parseVerdict('rejected'), 'rejected');
});

test('English form: REJECTED (uppercase)', () => {
  assert.equal(parseVerdict('REJECTED'), 'rejected');
});

test('English form: blocked (lowercase)', () => {
  assert.equal(parseVerdict('blocked'), 'blocked');
});

test('English form: BLOCKED (uppercase)', () => {
  assert.equal(parseVerdict('BLOCKED'), 'blocked');
});

test('Alias: returned maps to rejected', () => {
  assert.equal(parseVerdict('returned'), 'rejected');
});

test('Alias: RETURNED (uppercase) maps to rejected', () => {
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

test('Backward compatibility: Chinese 通过 continues to work', () => {
  assert.equal(parseVerdict('通过'), 'passed');
});

test('Backward compatibility: Chinese 打回 continues to work', () => {
  assert.equal(parseVerdict('打回'), 'rejected');
});

test('Backward compatibility: Chinese 阻塞 continues to work', () => {
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

test('Mixed case: PaSSed should map to passed', () => {
  assert.equal(parseVerdict('PaSSed'), 'passed');
});

test('Mixed case: ReTuRnEd should map to rejected', () => {
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
