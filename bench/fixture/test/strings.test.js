'use strict';
const assert = require('assert');
const { slugify } = require('../src/strings');

module.exports = {
  simple: () => assert.strictEqual(slugify('Hello World'), 'hello-world'),
};
