import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROLES, validateRouting } from '../../runtime/lib/routing.mjs';
import { applyDeny, buildCandidates, CANDIDATES_FILE, validateCandidates } from '../../runtime/lib/harness.mjs';

const installer = fileURLToPath(new URL('../../scripts/install.mjs', import.meta.url));
const doctor = fileURLToPath(new URL('../../scripts/doctor.mjs', import.meta.url));
const NOW = Date.parse('2026-06-01T00:00:00Z');

// Placeholder model ids only; real ids come from the routing table in a deployment.
const PI_MODEL = 'example/pi-model';
const HOST_MODEL = 'example/host-model';
// The routing table routes reviewer to the host agent, so the host model is authorized and detected.
const routing = validateRouting({
  version: 1,
  windows: [{
    id: 'fixture',
    from: '2020-01-01T00:00:00Z',
    to: '2100-01-01T00:00:00Z',
    roles: { ...Object.fromEntries(ROLES.map((role) => [role, { harness: 'pi', model: PI_MODEL, tier: 'strong' }])), reviewer: { harness: 'host-agent', model: HOST_MODEL, tier: 'strong' } },
  }],
});
const config = { roles: { ...Object.fromEntries(ROLES.map((role) => [role, 'pi'])), reviewer: 'host-agent' }, implementerRole: 'developer', deny: [] };

const withTmp = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt307-'));
  try { await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('pi and host-agent fixture yields an ordered candidate list per role ending with the host model', () => {
  const candidates = applyDeny(buildCandidates({ config, routing, now: NOW }), config.deny);
  for (const role of ROLES.filter((role) => role !== 'reviewer')) {
    assert.deepEqual(candidates[role], [{ harness: 'pi', model: PI_MODEL }, { harness: 'host-agent', model: HOST_MODEL }]);
  }
  assert.deepEqual(candidates.reviewer, [{ harness: 'host-agent', model: HOST_MODEL }]);
});

test('install writes the candidate file per role, last entry is the host model', withTmp((dir) => {
  const routingFile = join(dir, 'routing.json');
  writeFileSync(routingFile, JSON.stringify(routing));
  const target = join(dir, 'ws');
  mkdirSync(target);
  execFileSync(process.execPath, [installer, '--target', target, '--routing', routingFile, '--harness', 'claude']);
  const table = JSON.parse(readFileSync(join(target, CANDIDATES_FILE), 'utf8'));
  for (const role of ROLES) {
    const list = table.roles[role];
    assert.equal(list.at(-1).harness, 'host-agent');
    assert.equal(list.at(-1).model, HOST_MODEL);
  }
}));

test('empty, unknown-harness, and unauthorized candidates fail validation naming role and entry', () => {
  const valid = () => ({ version: 1, roles: buildCandidates({ config, routing, now: NOW }) });
  const empty = valid();
  empty.roles.fixer = [];
  assert.throws(() => validateCandidates(empty, { routing }), /role "fixer".*empty/);

  const unknown = valid();
  unknown.roles.reviewer = [{ harness: 'ghost', model: PI_MODEL }];
  assert.throws(() => validateCandidates(unknown, { routing }), /role "reviewer".*unknown harness "ghost"/);

  const unauthorized = valid();
  unauthorized.roles.chief = [{ harness: 'pi', model: 'example/rogue-model' }];
  assert.throws(() => validateCandidates(unauthorized, { routing }), /role "chief".*example\/rogue-model.*not authorized/);
});

test('a role whose candidates contain a denied model fails at load time, naming the role', () => {
  const table = { version: 1, roles: buildCandidates({ config, routing, now: NOW }) };
  assert.throws(() => validateCandidates(table, { routing, deny: [HOST_MODEL] }), /candidates for role "\w+" use model "example\/host-model" which is on the deny list/);
});

test('a role left empty after the deny list fails when candidates are generated, naming the role', () => {
  const candidates = { developer: [{ harness: 'pi', model: PI_MODEL }] };
  assert.throws(() => applyDeny(candidates, [PI_MODEL]), /role "developer" have no entries left after the deny list/);
});

test('doctor refuses a hand-edited candidate file naming the unauthorized model', withTmp((dir) => {
  const routingFile = join(dir, 'routing.json');
  writeFileSync(routingFile, JSON.stringify(routing));
  const target = join(dir, 'ws');
  mkdirSync(target);
  execFileSync(process.execPath, [installer, '--target', target, '--routing', routingFile, '--harness', 'claude']);
  const file = join(target, CANDIDATES_FILE);
  const table = JSON.parse(readFileSync(file, 'utf8'));
  table.roles.chief = [{ harness: 'pi', model: 'example/rogue-model' }];
  writeFileSync(file, JSON.stringify(table));
  const result = spawnSync(process.execPath, [doctor, '--target', target, '--routing', routingFile, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /role "chief".*example\/rogue-model.*not authorized/);
}));

test('doctor --json prints the effective per-role candidate list', withTmp((dir) => {
  const routingFile = join(dir, 'routing.json');
  writeFileSync(routingFile, JSON.stringify(routing));
  const target = join(dir, 'ws');
  mkdirSync(target);
  execFileSync(process.execPath, [installer, '--target', target, '--routing', routingFile, '--harness', 'claude']);
  const report = JSON.parse(execFileSync(process.execPath, [doctor, '--target', target, '--routing', routingFile, '--json'], { encoding: 'utf8' }));
  assert.deepEqual(report.installation.candidates.developer, ['pi/example/pi-model', 'host-agent/example/host-model']);
}));
