import test from 'node:test';
import assert from 'node:assert/strict';
import { findDanglingImports } from '../../runtime/lib/revert-check.mjs';

test('no references to deleted files reports nothing', () => {
  const files = new Map([
    ['runtime/lib/a.mjs', "import { b } from './b.mjs';\nexport const a = b;\n"],
    ['runtime/lib/b.mjs', 'export const b = 1;\n'],
  ]);
  assert.deepEqual(findDanglingImports({ deleted: ['runtime/lib/gone.mjs'], files }), []);
});

test('a remaining file importing a deleted module is reported with its specifier', () => {
  const files = new Map([
    ['host/outbox-bridge.mjs', "import { observeCycle } from '../runtime/lib/loop-stall.mjs';\n"],
    ['runtime/lib/other.mjs', "const mod = await import('./loop-stall.mjs');\n"],
  ]);
  assert.deepEqual(findDanglingImports({ deleted: ['runtime/lib/loop-stall.mjs'], files }), [
    { file: 'host/outbox-bridge.mjs', specifier: '../runtime/lib/loop-stall.mjs', target: 'runtime/lib/loop-stall.mjs' },
    { file: 'runtime/lib/other.mjs', specifier: './loop-stall.mjs', target: 'runtime/lib/loop-stall.mjs' },
  ]);
});

test('a file deleted by the same revert that imports another deleted file is not dangling', () => {
  const files = new Map([
    ['runtime/lib/x.mjs', "import { y } from './y.mjs';\n"],
    ['runtime/lib/y.mjs', 'export const y = 1;\n'],
    ['runtime/lib/keep.mjs', "import { y } from './y.mjs';\n"],
  ]);
  assert.deepEqual(findDanglingImports({ deleted: ['runtime/lib/x.mjs', 'runtime/lib/y.mjs'], files }), [
    { file: 'runtime/lib/keep.mjs', specifier: './y.mjs', target: 'runtime/lib/y.mjs' },
  ]);
});
