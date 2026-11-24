// Watch rules: `.roundtable/notify.json` under the RT root lists which loop events a supervising agent subscribes to.
// A matching event enqueues one outbox notification whose id is the event id, so a replay enqueues nothing new.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openOutbox } from './outbox.mjs';

export const WATCH_PATH = '.roundtable/notify.json';
export const EVENTS = ['issue-merged', 'issue-closed', 'pr-merged', 'ask-opened', 'blocked', 'main-red', 'window-reset', 'umbrella-done'];

const isIssue = (n) => Number.isInteger(n) && n > 0;
const validTarget = (t) => t === '*' || isIssue(t) || (Array.isArray(t) && t.length > 0 && t.every(isIssue)) || isIssue(t?.umbrella);

// Rules are `{ event, target, recipient }`: target is `*`, an issue number, a list of issue numbers, or `{ umbrella }` (the umbrella and its children).
export function loadWatchRules(root) {
  const file = join(root, WATCH_PATH);
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf8')).rules.map((rule) => {
    if (!EVENTS.includes(rule.event)) throw new TypeError(`unknown watch event: ${rule.event}`);
    if (!validTarget(rule.target)) throw new TypeError(`invalid watch target: ${JSON.stringify(rule.target)}`);
    if (typeof rule.recipient !== 'string' || rule.recipient.length === 0) throw new TypeError('watch recipient must be a non-empty label');
    return rule;
  });
}

// An event is `{ event, issue, umbrella, recipient }`; `umbrella` is the parent umbrella of its issue when the producer knows it.
export function matchesRule(rule, event) {
  if (rule.event !== event.event || rule.recipient !== event.recipient) return false;
  const { target } = rule;
  if (target === '*') return true;
  if (typeof target === 'number') return event.issue === target;
  if (Array.isArray(target)) return target.includes(event.issue);
  return event.issue === target.umbrella || event.umbrella === target.umbrella;
}

// Enqueues the notification when a rule matches. `key` identifies the cause within the event (e.g. the issue number).
export function notifyEvent(root, { event, issue = null, umbrella, recipient = 'supervisor', key, commits }) {
  const cause = { event, issue, umbrella, recipient };
  if (!loadWatchRules(root).some((rule) => matchesRule(rule, cause))) return false;
  return openOutbox(root).enqueue({ id: `watch:${event}:${key}`, kind: 'notification', issue, payload: { subtype: 'watch', event, key: String(key), recipient, commits } });
}

// Enqueues `umbrella-done` (id `watch:umbrella-done:<umbrella>`, so a re-run enqueues nothing) once every child has a merge commit.
// The caller supplies the children as `[{ issue, commit }]`, with `commit: null` until that child merges, and the final main commit.
export function checkUmbrellaDone(root, { umbrella, children, main }) {
  if (children.some((child) => child.commit === null)) return false;
  return notifyEvent(root, { event: 'umbrella-done', issue: umbrella, umbrella, key: umbrella, commits: { children: children.map((child) => child.commit), main } });
}
