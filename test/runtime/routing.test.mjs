import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ROLES, RoutingError, activeWindow, formatRoutingFacts, loadRouting, renderRolePrompt, routingFacts, validateRouting,
} from '../../runtime/lib/routing.mjs';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const WINDOW = { id: '2026-11', from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' };
const entry = (model, tier = 'standard', harness = 'pi') => ({ harness, model, tier });
const roles = () => ({
  chief: entry('model-chief'),
  developer: entry('model-dev'),
  fixer: entry('model-fix'),
  reviewer: entry('model-review-strong', 'strong'),
  researcher: entry('model-research'),
  crosscheck: entry('model-crosscheck', 'strong'),
});
const table = () => ({ version: 1, windows: [{ ...WINDOW, roles: roles() }] });

test('a window missing a role is a RoutingError naming the window and role', () => {
  const config = table();
  delete config.windows[0].roles.fixer;
  assert.throws(() => validateRouting(config), (error) => (
    error instanceof RoutingError
    && error.code === 'ROUTING_INVALID'
    && /^routing /.test(error.message)
    && error.message.includes('2026-11')
    && error.message.includes('fixer')
  ));
});

test('an empty harness or model is rejected', () => {
  for (const field of ['harness', 'model']) {
    for (const value of ['', '   ']) {
      const config = table();
      config.windows[0].roles.developer[field] = value;
      assert.throws(() => validateRouting(config), (error) => (
        error instanceof RoutingError && error.message.includes('developer') && error.message.includes(field)
      ));
    }
  }
});

test('windows must be sorted and must not overlap', () => {
  const unsorted = { version: 1, windows: [
    { ...WINDOW, roles: roles() },
    { id: '2026-10', from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', roles: roles() },
  ] };
  assert.throws(() => validateRouting(unsorted), /sorted/);
  const overlap = { version: 1, windows: [
    { ...WINDOW, roles: roles() },
    { id: '2026-11b', from: '2026-11-15T00:00:00.000Z', to: '2026-12-15T00:00:00.000Z', roles: roles() },
  ] };
  assert.throws(() => validateRouting(overlap), /overlap/);
});

test('reviewer and fixer tiers must be at least the developer tier', () => {
  for (const role of ['reviewer', 'fixer']) {
    const config = table();
    config.windows[0].roles[role].tier = 'economy';
    assert.throws(() => validateRouting(config), (error) => (
      error instanceof RoutingError && error.message.includes(role) && error.message.includes('developer')
    ));
  }
});

test('a valid table is returned unchanged and produces the routing facts block', () => {
  const source = table();
  const validated = validateRouting(source);
  assert.equal(validated, source);
  const facts = routingFacts(validated, NOW);
  assert.equal(facts.window, '2026-11');
  const block = formatRoutingFacts(facts);
  assert.match(block, /^## Routing for this run\n/);
  for (const role of ROLES) assert.match(block, new RegExp(`- ${role}: harness=\\S+ model=\\S+ tier=(?:economy|standard|strong)`));
  assert.match(block, /model-review-strong/);
  assert.match(block, /expected and allowed/);
  assert.match(block, /do not stop, ask, or refuse/);
});

test('no routing window covering now is a RoutingError', () => {
  const validated = validateRouting(table());
  assert.throws(() => activeWindow(validated, new Date('2027-01-01T00:00:00.000Z')), (error) => (
    error instanceof RoutingError && error.code === 'ROUTING_INVALID' && /no routing window/.test(error.message)
  ));
  assert.throws(() => routingFacts(validated, new Date('2026-10-01T00:00:00.000Z')), RoutingError);
});

test('the real chief prompt renders the routed reviewer model, tier, and allowance sentence', async () => {
  const prompt = await readFile(new URL('../../.agents/skills/roundtable-work/prompts/roles/chief.md', import.meta.url), 'utf8');
  const validated = validateRouting(table());
  assert.notEqual(validated.windows[0].roles.reviewer.tier, validated.windows[0].roles.developer.tier, 'reviewer is graded stronger than developer');
  const rendered = renderRolePrompt(prompt, routingFacts(validated, NOW));
  assert.match(rendered, /model-review-strong/);
  assert.match(rendered, /- reviewer: harness=pi model=model-review-strong tier=strong/);
  assert.match(rendered, /expected and allowed/);
});

test('an invalid routing table makes the CLI exit non-zero before any pass', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt174-routing-'));
  try {
    const file = join(root, 'routing.json');
    const config = table();
    delete config.windows[0].roles.crosscheck;
    await writeFile(file, JSON.stringify(config));
    const result = spawnSync(process.execPath, [
      'runtime/rtd.mjs', '--work-root', root, '--queue', join(root, 'queue.json'),
      '--handler', join(root, 'missing-handler.mjs'), '--routing', file,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^routing: /);
    assert.match(result.stderr, /2026-11/);
    assert.match(result.stderr, /crosscheck/);
    assert.equal(result.stdout, '');
    assert.equal((await readdir(root)).includes('.roundtable'), false, 'no queue or lock work started');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('loadRouting reads and validates a JSON table', async () => {
  const root = await mkdtemp(join(process.cwd(), 'rt174-routing-'));
  try {
    const file = join(root, 'routing.json');
    await writeFile(file, JSON.stringify(table()));
    assert.equal((await loadRouting(file)).windows[0].id, '2026-11');
  } finally { await rm(root, { recursive: true, force: true }); }
});
