import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadGoals } from '../../runtime/lib/goals.mjs';
import { safetyFiles } from '../../runtime/lib/safety.mjs';
import { autonomyTier, loadAutonomy } from '../../runtime/lib/autonomy.mjs';

// Seams: loadGoals(path), safetyFiles(paths), and autonomyTier(action, autonomy) for the goal file.
// Invalid goal files are written to a temp dir; the committed file is only read.
const GOALS = resolve(import.meta.dirname, '../../runtime/goals.json');
const DEFAULTS = resolve(import.meta.dirname, '../../runtime/defaults/autonomy.json');
const MISSING = '/nonexistent/rt-goals-host.json';

const SHIPPED = {
  version: 1,
  northStar: { metric: 'mtbiHours', target: 72 },
  capabilities: { L: 'self', H: 'self', R: 'self', D: 'self', M: 'self', B: 'self', S: 'self', O: 'self' },
  metrics: { windowDays: 7, mtbiHoursMin: 24, firstPassRateMin: 0.8, ownerPullInsPerWeekMax: 3 },
  selfReview: { cadenceHours: 24, maxPerDay: 3, maxOpen: 5, hostPatchMaxAgeDays: 3, failureRepeat: { count: 3, days: 7 } },
  reporting: { digestIssue: null, digestHourUtc: 15 },
  exit: { windowHours: 72, minMergedPrs: 6, minSelfSourcedCompleted: 1 },
};

// Writes the mutated goal file to a temp dir and loads it; returns the loader's promise.
async function loadMutated(mutate) {
  const dir = await mkdtemp(join(tmpdir(), 'goals-test-'));
  try {
    const goal = structuredClone(SHIPPED);
    mutate(goal);
    const path = join(dir, 'goals.json');
    await writeFile(path, JSON.stringify(goal));
    return await loadGoals(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the committed goal file is valid and holds the defaults (acceptance 1, 2)', async () => {
  assert.deepEqual(await loadGoals(GOALS), SHIPPED);
});

const BAD = [
  ['version', (g) => { g.version = 2; }],
  ['northStar.metric', (g) => { g.northStar.metric = 'other'; }],
  ['northStar.target', (g) => { g.northStar.target = 0; }],
  ['northStar.foo', (g) => { g.northStar.foo = 1; }],
  ['capabilities.O', (g) => { delete g.capabilities.O; }],
  ['capabilities.L', (g) => { g.capabilities.L = 'fast'; }],
  ['capabilities.X', (g) => { g.capabilities.X = 'self'; }],
  ['metrics.windowDays', (g) => { g.metrics.windowDays = 1.5; }],
  ['metrics.firstPassRateMin', (g) => { g.metrics.firstPassRateMin = 1.5; }],
  ['metrics.mtbiHoursMin', (g) => { g.metrics.mtbiHoursMin = null; }],
  ['selfReview.cadenceHours', (g) => { g.selfReview.cadenceHours = '24'; }],
  ['selfReview.failureRepeat.count', (g) => { g.selfReview.failureRepeat.count = -1; }],
  ['reporting.digestHourUtc', (g) => { g.reporting.digestHourUtc = 24; }],
  ['reporting.digestIssue', (g) => { g.reporting.digestIssue = 1.5; }],
  ['exit.windowHours', (g) => { delete g.exit.windowHours; }],
  ['extra', (g) => { g.extra = true; }],
];

for (const [key, mutate] of BAD) {
  test(`an invalid goal file is rejected and the error names ${key} (acceptance 2)`, async () => {
    await assert.rejects(loadMutated(mutate), { name: 'Error', message: `Goal file key is invalid: ${key}` });
  });
}

test('runtime/goals.json is a safety file, and only that exact path matches (acceptance 3)', () => {
  assert.deepEqual(safetyFiles(['runtime/goals.json']), ['runtime/goals.json']);
  assert.deepEqual(safetyFiles(['runtime/goals.json.bak', 'x/runtime/goals.json', 'runtime/goalsXjson']), []);
});

test('a change to runtime/goals.json is approve-first with the safety-file reason (acceptance 3)', async () => {
  const { autonomy } = await loadAutonomy({ defaultsPath: DEFAULTS, hostPath: MISSING });
  const action = { kind: 'merge', paths: ['runtime/goals.json'], labels: [], risk: 'risk:low' };
  assert.deepEqual(autonomyTier(action, autonomy), { tier: 'approve-first', reasons: ['safety-file:runtime/goals.json'], approver: 'decider' });
});
