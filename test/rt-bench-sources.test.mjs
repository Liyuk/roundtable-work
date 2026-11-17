import test from 'node:test';
import assert from 'node:assert/strict';
import { readInterventions, readMerges } from '../scripts/rt-bench/sources.mjs';

// Layouts are defined in the header of scripts/rt-bench/sources.mjs. Expected instants are literals
// worked out by hand from the US Pacific rules (PST UTC-8, PDT UTC-7) and UTC+8 for CST.
// 2026-03-08 is the spring-forward day and 2026-11-01 the fall-back day in America/Los_Angeles.

test('Pacific standard time row converts with UTC-8', () => {
  const { events } = readInterventions('2026-11-15 10:00\tdecision\t#391\tanswer');
  assert.deepEqual(events, [
    { at: '2026-11-15T18:00:00.000Z', kind: 'decision', ref: '#391', raw: '2026-11-15 10:00\tdecision\t#391\tanswer' },
  ]);
});

test('Pacific daylight time rows convert with UTC-7 on both sides of the DST changes', () => {
  const { events } = readInterventions(
    ['2026-03-08 01:30\tliveness\t#1', '2026-03-08 10:00\tliveness\t#2', '2026-10-31 10:00\tliveness\t#3', '2026-11-02 10:00\tliveness\t#4'].join('\n'),
  );
  assert.deepEqual(events.map((e) => e.at), [
    '2026-03-08T09:30:00.000Z', // still PST before 02:00 spring-forward
    '2026-03-08T17:00:00.000Z', // PDT
    '2026-10-31T17:00:00.000Z', // PDT
    '2026-11-02T18:00:00.000Z', // PST after fall-back
  ]);
});

test('ISO T separator and seconds are accepted', () => {
  const { events } = readInterventions('2026-11-15T10:00:30\tliveness\t#5');
  assert.equal(events[0].at, '2026-11-15T18:00:30.000Z');
});

test('date-only intervention rows are anchored at 23:59:59 Pacific and form a contiguous sequence', () => {
  const { events, malformed } = readInterventions(['2026-10-31', '2026-11-01', '2026-11-02'].map((d) => `${d}\tself-repair\tnone`).join('\n'));
  assert.equal(malformed, 0);
  assert.deepEqual(events.map((e) => e.at), [
    '2026-11-01T06:59:59.000Z', // 23:59:59 PDT
    '2026-11-02T07:59:59.000Z', // 23:59:59 PST, the day after the DST change
    '2026-11-03T07:59:59.000Z',
  ]);
});

test('UTC+8 merge rows convert with +8, marked CST or UTC+8', () => {
  const { events, malformed } = readMerges(['2026-11-16 09:55 CST\t#101', '2026-11-16 09:55:10 UTC+8\t#102'].join('\n'));
  assert.equal(malformed, 0);
  assert.deepEqual(events.map((e) => [e.at, e.kind, e.ref]), [
    ['2026-11-16T01:55:00.000Z', 'merge', '#101'],
    ['2026-11-16T01:55:10.000Z', 'merge', '#102'],
  ]);
});

test('date-only merge rows are anchored at 23:59:59 in UTC+8', () => {
  const { events } = readMerges('2026-11-16 CST\t#103');
  assert.equal(events[0].at, '2026-11-16T15:59:59.000Z');
});

test('malformed rows are counted, never converted to a zero or a rolled-over date', () => {
  const text = [
    'not a row',
    '2026-02-30 10:00\tdecision\t#1', // no such date
    '2026-11-15 24:00\tdecision\t#2', // hour out of range
    '2026-11-15 10:00\tdecision', // missing ref
    '2026-11-15 10:00 PM\tdecision\t#3', // unknown format
    '2026-11-15 10:00\tdecision\t#4', // valid
  ].join('\n');
  const { events, malformed } = readInterventions(text);
  assert.equal(malformed, 5);
  assert.deepEqual(events.map((e) => e.ref), ['#4']);
});

test('merge rows without a UTC+8 marker are malformed', () => {
  const { events, malformed } = readMerges('2026-11-16 09:55\t#104\n2026-11-16 09:55 PST\t#105');
  assert.equal(malformed, 2);
  assert.deepEqual(events, []);
});

test('blank lines are ignored and lastSeen is the latest parsed instant, ignoring malformed rows', () => {
  const text = ['2026-11-16 10:00\tliveness\t#1', '', 'garbage', '2026-11-15 10:00\tliveness\t#2', ''].join('\n');
  const { events, malformed, lastSeen } = readInterventions(text);
  assert.equal(events.length, 2);
  assert.equal(malformed, 1);
  assert.equal(lastSeen, '2026-11-16T18:00:00.000Z');
});

test('empty input yields no events, zero malformed rows and no lastSeen', () => {
  assert.deepEqual(readMerges(''), { events: [], malformed: 0, lastSeen: null });
});
