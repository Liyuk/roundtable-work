// Timer firing: due one-shot and recurring timers enter the event inbox once per firing. Fixtures only: no network, no real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INBOX_PATH, KINDS, openInbox } from '../runtime/lib/event-inbox.mjs';
import { openTimers } from '../runtime/lib/event-timers.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = '2020-01-01T00:00:00Z';
const baseMs = Date.parse(BASE);
const event = { kind: 'timer', issue: null, payload: { note: 'fixture' } };

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rt-timers-'));
  try { fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const inboxLines = (root) => (existsSync(join(root, INBOX_PATH)) ? readFileSync(join(root, INBOX_PATH), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === undefined) : []);

test('a due one-shot is accepted once and removed from timers', () => withRoot((root) => {
  openTimers(root).once({ id: 'a', at: BASE, event });
  assert.equal(openTimers(root).fire(baseMs), 1);
  assert.deepEqual(inboxLines(root).map((e) => e.source_event_id), [`timer:a:${baseMs}`]);
  assert.deepEqual(openTimers(root).list(), []);
}));

test('a replayed firing is de-duplicated by source_event_id', () => withRoot((root) => {
  openTimers(root).once({ id: 'a', at: BASE, event });
  openTimers(root).fire(baseMs);
  openTimers(root).once({ id: 'a', at: BASE, event });
  assert.equal(openTimers(root).fire(baseMs), 0);
  assert.equal(inboxLines(root).length, 1);
}));

test('a recurring timer behind by three cadences fires once per due occurrence', () => withRoot((root) => {
  openTimers(root).recurring({ id: 'r', at: BASE, cadenceMs: 1000, event });
  assert.equal(openTimers(root).fire(baseMs + 2000), 3);
  assert.deepEqual(inboxLines(root).map((e) => e.source_event_id), [0, 1000, 2000].map((d) => `timer:r:${baseMs + d}`));
  assert.equal(openTimers(root).list()[0].at, baseMs + 3000);
}));

test('timer is an inbox kind; a recurring timer needs a positive cadence', () => withRoot((root) => {
  assert.ok(KINDS.includes('timer'));
  assert.throws(() => openTimers(root).recurring({ id: 'r', at: BASE, cadenceMs: 0, event }), TypeError);
}));

// Host: rt-sched.py fire_timers() under a temp RT_HOME. The Python side only reads and writes under that root.
const HOST_SNIPPET = `
import importlib.util, sys, time
spec = importlib.util.spec_from_file_location("rt_sched", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
s = mod.Sched(False, True)
if sys.argv[2] == "hold":
    s._resume_hold_until = time.time() + 600
s.fire_timers()
print("fired-check-done")
`;
function hostFire(root, mode) {
  if (mode === 'stop') writeFileSync(join(root, 'STOP'), '');
  const r = spawnSync('python3', ['-c', HOST_SNIPPET, join(repo, 'host', 'rt-sched.py'), mode], {
    env: { ...process.env, RT_HOME: root, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fired-check-done/);
}

test('host: a due timer fires into the inbox', () => withRoot((root) => {
  openTimers(root).once({ id: 'h', at: BASE, event });
  hostFire(root, 'run');
  assert.deepEqual(inboxLines(root).map((e) => e.source_event_id), [`timer:h:${baseMs}`]);
}));

test('host: a STOP file skips timer firing', () => withRoot((root) => {
  openTimers(root).once({ id: 'h', at: BASE, event });
  hostFire(root, 'stop');
  assert.equal(inboxLines(root).length, 0);
}));

test('host: the cycle-gap hold skips timer firing', () => withRoot((root) => {
  openTimers(root).once({ id: 'h', at: BASE, event });
  hostFire(root, 'hold');
  assert.equal(inboxLines(root).length, 0);
  assert.equal(openTimers(root).list().length, 1);
}));
