import test from 'node:test';
import assert from 'node:assert/strict';
import { seriesKey } from '../../runtime/lib/series-key.mjs';
import { serializationReason } from '../../runtime/lib/workers.mjs';

test('seriesKey maps bracket tokens to series keys', () => {
  const cases = [
    ['[RT-B7a] x', 'rt-b7'],
    ['[RT-B7b] y', 'rt-b7'],
    ['[RT-B1]', 'rt-b1'],
    ['[RT-B10]', 'rt-b10'],
    ['[RT-F-1c]', 'rt-f-1'],
    ['[I18N-4]', 'i18n-4'],
    ['[Pages 4/4]', 'pages'],
    ['[RT]', 'rt'],
    ['no bracket', null],
  ];
  for (const [title, key] of cases) assert.equal(seriesKey(title), key, title);
});

test('distinct bracket series never share a key', () => {
  assert.notEqual(seriesKey('[RT-B1]'), seriesKey('[RT-B2]'));
  assert.notEqual(seriesKey('[RT-B10]'), seriesKey('[RT-B1]'));
});

const unparseable = '## Notes\nno touch set here';

test('same-series issues without a parseable touch set serialize', () => {
  const a = { id: '1', title: '[RT-B7a] x', body: unparseable };
  const b = { id: '2', title: '[RT-B7b] y', body: unparseable };
  assert.equal(serializationReason(a, b), 'series fallback');
});

test('distinct-series issues with disjoint parseable touch sets do not serialize', () => {
  const a = { id: '1', title: '[RT-B1] x', body: '## Touch set\n- runtime/a.mjs\n' };
  const b = { id: '2', title: '[RT-B2] y', body: '## Touch set\n- runtime/b.mjs\n' };
  assert.equal(serializationReason(a, b), null);
});
