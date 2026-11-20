import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWatchRules, matchesRule, notifyEvent } from '../../runtime/lib/watch-rules.mjs';
import { openOutbox } from '../../runtime/lib/outbox.mjs';
import { createGitHubOutboxProvider } from '../../runtime/lib/outbox-github.mjs';

const writeRules = (root, rules) => {
  mkdirSync(join(root, '.roundtable'), { recursive: true });
  writeFileSync(join(root, '.roundtable', 'notify.json'), JSON.stringify({ rules }));
};
const rootWith = (rules) => {
  const root = mkdtempSync(join(tmpdir(), 'watch-'));
  writeRules(root, rules);
  return root;
};

test('loader rejects an unknown event name and accepts the known ones', () => {
  assert.throws(() => loadWatchRules(rootWith([{ event: 'issue-exploded', target: '*', recipient: 'supervisor' }])), /unknown watch event: issue-exploded/);
  const rules = loadWatchRules(rootWith([{ event: 'issue-merged', target: '*', recipient: 'supervisor' }]));
  assert.equal(rules.length, 1);
  assert.deepEqual(loadWatchRules(mkdtempSync(join(tmpdir(), 'watch-empty-'))), []);
});

test('matching: issue numbers, umbrella with its children, `*`, and the recipient label', () => {
  const merged = (issue, umbrella) => ({ event: 'issue-merged', issue, umbrella, recipient: 'supervisor' });
  const rule = (target, recipient = 'supervisor') => ({ event: 'issue-merged', target, recipient });

  assert.equal(matchesRule(rule(7), merged(7)), true);
  assert.equal(matchesRule(rule(7), merged(8)), false);
  assert.equal(matchesRule(rule([7, 9]), merged(9)), true);
  assert.equal(matchesRule(rule({ umbrella: 629 }), merged(12, 629)), true);
  assert.equal(matchesRule(rule({ umbrella: 629 }), merged(629)), true);
  assert.equal(matchesRule(rule({ umbrella: 629 }), merged(12, 630)), false);
  assert.equal(matchesRule(rule('*'), merged(3)), true);
  assert.equal(matchesRule(rule('*'), { event: 'main-red', issue: null, recipient: 'supervisor' }), false);
  assert.equal(matchesRule(rule('*', 'owner'), merged(3)), false);
  assert.equal(matchesRule(rule('*'), { event: 'issue-closed', issue: 3, recipient: 'supervisor' }), false);
});

test('an event is enqueued once: the id is the event id and a replay after restart enqueues nothing new', () => {
  const root = rootWith([{ event: 'issue-merged', target: '*', recipient: 'supervisor' }]);
  assert.equal(notifyEvent(root, { event: 'issue-merged', issue: 7, key: '7' }), true);
  assert.equal(notifyEvent(root, { event: 'issue-merged', issue: 7, key: '7' }), false);
  const reopened = openOutbox(root);
  assert.equal(reopened.enqueue({ id: 'watch:issue-merged:7', kind: 'notification', issue: 7, payload: { subtype: 'watch', event: 'issue-merged' } }), false);
  assert.deepEqual(reopened.items().map((i) => [i.id, i.kind]), [['watch:issue-merged:7', 'notification']]);
});

test('a watch rule on issue-merged produces exactly one notification per merged issue', () => {
  const root = rootWith([{ event: 'issue-merged', target: '*', recipient: 'supervisor' }]);
  notifyEvent(root, { event: 'issue-merged', issue: 7, key: '7' });
  notifyEvent(root, { event: 'issue-merged', issue: 8, key: '8' });
  notifyEvent(root, { event: 'issue-merged', issue: 7, key: '7' });
  notifyEvent(root, { event: 'issue-closed', issue: 7, key: '7' });
  const items = openOutbox(root).items().filter((i) => i.kind === 'notification');
  assert.deepEqual(items.map((i) => [i.id, i.issue]), [['watch:issue-merged:7', 7], ['watch:issue-merged:8', 8]]);
});

test('the GitHub provider accepts the watch notification subtype', async () => {
  const comments = [];
  const writer = { listComments: async () => [], createComment: async (_issue, body) => comments.push(body) };
  const provider = createGitHubOutboxProvider({ writer });
  await provider.deliver({ id: 'watch:issue-merged:7', kind: 'notification', issue: 7, payload: { subtype: 'watch', event: 'issue-merged', key: '7', recipient: 'supervisor' } });
  assert.match(comments[0], /<!-- rt:outbox watch:issue-merged:7 -->\nWatch issue-merged 7 for supervisor/);
});
