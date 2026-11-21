import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkUmbrellaDone } from '../../runtime/lib/watch-rules.mjs';
import { openOutbox, dispatch } from '../../runtime/lib/outbox.mjs';
import { createNotifyFileProvider, NOTIFY_PATH } from '../../runtime/lib/outbox-notify.mjs';

const UMBRELLA = 629;
const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'umbrella-done-'));
  mkdirSync(join(root, '.roundtable'), { recursive: true });
  writeFileSync(join(root, '.roundtable', 'notify.json'), JSON.stringify({ rules: [{ event: 'umbrella-done', target: { umbrella: UMBRELLA }, recipient: 'supervisor' }] }));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const deliverAll = (root) => dispatch({ outbox: openOutbox(root), provider: createNotifyFileProvider({ root }) });
const lines = (root) => (existsSync(join(root, NOTIFY_PATH)) ? readFileSync(join(root, NOTIFY_PATH), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('the umbrella-done notice is emitted once, after the last child merges, with the child commits and the main commit', async () => {
  await withRoot(async (root) => {
    const children = [{ issue: 630, commit: null }, { issue: 631, commit: null }];
    const check = () => checkUmbrellaDone(root, { umbrella: UMBRELLA, children, main: 'f00ba4' });

    children[0].commit = 'aaa111';
    assert.equal(check(), false);
    await deliverAll(root);
    assert.equal(lines(root).length, 0);

    children[1].commit = 'bbb222';
    assert.equal(check(), true);
    await deliverAll(root);
    assert.equal(lines(root).length, 1);
    assert.equal(lines(root)[0].event, 'umbrella-done');
    assert.equal(lines(root)[0].issue, UMBRELLA);
    assert.deepEqual(lines(root)[0].commits, { children: ['aaa111', 'bbb222'], main: 'f00ba4' });
  });
});

test('re-running the completion check after a restart adds no second umbrella-done line', async () => {
  await withRoot(async (root) => {
    const children = [{ issue: 630, commit: 'aaa111' }, { issue: 631, commit: 'bbb222' }];
    checkUmbrellaDone(root, { umbrella: UMBRELLA, children, main: 'f00ba4' });
    await deliverAll(root);

    assert.equal(checkUmbrellaDone(root, { umbrella: UMBRELLA, children, main: 'f00ba4' }), false);
    await deliverAll(root);
    assert.equal(lines(root).filter((l) => l.event === 'umbrella-done').length, 1);
    assert.equal(openOutbox(root).items().filter((i) => i.id === `watch:umbrella-done:${UMBRELLA}`).length, 1);
  });
});
