'use strict';
const assert = require('assert');
const { add, sub } = require('../src/math');

module.exports = {
  add: () => assert.strictEqual(add(2, 3), 5),
  sub: () => assert.strictEqual(sub(5, 3), 2),
};
