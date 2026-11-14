import test from 'node:test';
import assert from 'node:assert/strict';
import { parentCloseReason, autoCloseParent } from '../../runtime/lib/parent-close.mjs';

const met = { hasPullRequest: false, acceptanceMet: true, children: ['CLOSED', 'CLOSED'], mainCi: 'success' };

test('a parent with no PR closes once its acceptance is met, all children are closed and main CI is green', () => {
  assert.equal(parentCloseReason(met), 'no PR needed: acceptance verified, all 2 sub-issues closed, main CI green');
});

test('a parent does not close while a child is open, acceptance is unmet, a PR exists or main CI is not green', () => {
  assert.equal(parentCloseReason({ ...met, children: ['CLOSED', 'OPEN'] }), null);
  assert.equal(parentCloseReason({ ...met, children: [] }), null);
  assert.equal(parentCloseReason({ ...met, acceptanceMet: false }), null);
  assert.equal(parentCloseReason({ ...met, hasPullRequest: true }), null);
  assert.equal(parentCloseReason({ ...met, mainCi: 'failure' }), null);
});

test('autoCloseParent closes the parent exactly once with the reason when met, and never otherwise', async () => {
  const closes = [];
  const close = async (parent, reason) => { closes.push([parent, reason]); };
  const parent = { number: 264 };
  assert.deepEqual(await autoCloseParent({ parent, state: met, close }), { closed: true, reason: 'no PR needed: acceptance verified, all 2 sub-issues closed, main CI green' });
  assert.deepEqual(closes, [[parent, 'no PR needed: acceptance verified, all 2 sub-issues closed, main CI green']]);
  assert.deepEqual(await autoCloseParent({ parent, state: { ...met, mainCi: 'failure' }, close }), { closed: false, reason: null });
  assert.equal(closes.length, 1);
});
