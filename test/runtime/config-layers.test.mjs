import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfigLayers } from '../../runtime/lib/config-layers.mjs';

// Seam: loadConfigLayers({ name, workspace, globalPath, defaultsPath, rules }). Every file lives in a temp dir; the real home is never read.
const RULES = { max: 'min', ok: 'and', allowed: 'subset' };
const DEFAULTS = { max: 5, ok: true, allowed: ['a', 'b', 'c'] };
const roots = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture({ defaults = DEFAULTS, global, project }) {
  const root = mkdtempSync(join(tmpdir(), 'config-layers-'));
  roots.push(root);
  const defaultsPath = join(root, 'defaults.json');
  const globalPath = join(root, 'global.json');
  const workspace = join(root, 'ws');
  writeFileSync(defaultsPath, JSON.stringify(defaults));
  if (global !== undefined) writeFileSync(globalPath, JSON.stringify(global));
  mkdirSync(join(workspace, '.roundtable'), { recursive: true });
  if (project !== undefined) writeFileSync(join(workspace, '.roundtable', 'test.json'), JSON.stringify(project));
  return { defaultsPath, globalPath, workspace };
}

const load = (files, rules = RULES) => loadConfigLayers({ name: 'test', rules, ...files });

test('precedence: defaults < global < project, each key reports the layer that set it', async () => {
  const r = await load(fixture({ global: { max: 4 }, project: { max: 2 } }));
  assert.equal(r.values.max, 2);
  assert.equal(r.sources.max, 'project');
  assert.deepEqual(r.rejected, []);
});

test('a project value stricter than global is accepted', async () => {
  const r = await load(fixture({ global: { max: 4 }, project: { max: 3 } }));
  assert.deepEqual([r.values.max, r.sources.max], [3, 'project']);
  assert.deepEqual(r.rejected, []);
});

test('a global value looser than defaults is rejected and the default stays', async () => {
  const r = await load(fixture({ global: { max: 9 } }));
  assert.equal(r.values.max, 5);
  assert.equal(r.sources.max, 'defaults');
  assert.deepEqual(r.rejected.map(({ layer, key }) => [layer, key]), [['global', 'max']]);
  assert.equal(typeof r.rejected[0].reason, 'string');
});

test('a project value looser than global is rejected and the global value stays', async () => {
  const r = await load(fixture({ global: { max: 3 }, project: { max: 4 } }));
  assert.deepEqual([r.values.max, r.sources.max], [3, 'global']);
  assert.deepEqual(r.rejected.map(({ layer, key }) => [layer, key]), [['project', 'max']]);
});

test('and rule: a boolean may only be switched off by an upper layer', async () => {
  const off = await load(fixture({ global: { ok: true }, project: { ok: false } }));
  assert.deepEqual([off.values.ok, off.sources.ok, off.rejected.length], [false, 'project', 0]);
  const on = await load(fixture({ global: { ok: false }, project: { ok: true } }));
  assert.deepEqual([on.values.ok, on.sources.ok], [false, 'global']);
  assert.deepEqual(on.rejected.map(({ layer, key }) => [layer, key]), [['project', 'ok']]);
});

test('subset rule: arrays intersect with the lower layer and extra entries are rejected', async () => {
  const r = await load(fixture({ global: { allowed: ['a', 'b'] }, project: { allowed: ['b', 'c', 'd'] } }));
  assert.deepEqual(r.values.allowed, ['b']);
  assert.equal(r.sources.allowed, 'project');
  assert.deepEqual(r.rejected.map(({ layer, key }) => [layer, key]), [['project', 'allowed']]);
});

test('an unknown key in an upper layer is rejected and changes nothing', async () => {
  const r = await load(fixture({ project: { zzz: 1 } }));
  assert.deepEqual(r.values, DEFAULTS);
  assert.deepEqual(r.rejected.map(({ layer, key }) => [layer, key]), [['project', 'zzz']]);
});

test('absent layer files leave the defaults alone', async () => {
  const r = await load(fixture({}));
  assert.deepEqual(r.values, DEFAULTS);
  assert.deepEqual(Object.values(r.sources), ['defaults', 'defaults', 'defaults']);
  assert.deepEqual(r.rejected, []);
});

test('a default key without a tighten-only rule fails the load', async () => {
  await assert.rejects(load(fixture({ defaults: { ...DEFAULTS, extra: 1 } })), /extra/);
});

test('a layer value with the wrong type fails the load and the error names only the key', async () => {
  await assert.rejects(load(fixture({ global: { max: 'x-secret' } })), (err) => /max/.test(err.message) && !err.message.includes('x-secret'));
});

test('the real limits defaults load with no layer files and report defaults provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'config-layers-'));
  roots.push(root);
  const r = await loadConfigLayers({ name: 'limits', workspace: root, globalPath: join(root, 'none.json') });
  assert.equal(r.values.maxAttemptsPerAssignment, 2);
  assert.equal(r.values.allowAutoFollowups, false);
  assert.equal(new Set(Object.values(r.sources)).size, 1);
  assert.equal(r.sources.maxAttemptsPerAssignment, 'defaults');
});
