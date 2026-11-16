'use strict';
// Minimal test runner: loads every test/*.test.js file; each exports an object of named test functions.
const fs = require('fs');
const path = require('path');
let failed = 0;
let passed = 0;
for (const f of fs.readdirSync(__dirname).filter((x) => x.endsWith('.test.js')).sort()) {
  const tests = require(path.join(__dirname, f));
  for (const [name, fn] of Object.entries(tests)) {
    try {
      fn();
      passed += 1;
    } catch (e) {
      failed += 1;
      console.error(`FAIL ${f} ${name}: ${e.message}`);
    }
  }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
