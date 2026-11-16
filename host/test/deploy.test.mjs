import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciGreen, deploy } from '../deploy';

const here = dirname(fileURLToPath(import.meta.url));
const deployBin = join(here, '..', 'deploy');
const T0 = 1_000_000_000_000;
const GREEN = `node -e "console.log(JSON.stringify({status:'completed',conclusion:'success'}))"`;
const RED = `node -e "console.log(JSON.stringify({status:'completed',conclusion:'failure'}))"`;
const SMOKE_OK = 'node -e "process.exit(0)"';

function sandbox(over = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rt-host-'));
  const releases = join(root, 'releases');
  mkdirSync(releases);
  const clock = { t: T0, sleeps: 0 };
  const cfg = {
    releases,
    ci: GREEN,
    smoke: SMOKE_OK,
    fetch: () => 'bbb2222',
    extract: (sha, dir) => writeFileSync(join(dir, 'VERSION'), sha),
    heartbeat: join(root, 'heartbeat'),
    pollMs: 1000,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      clock.sleeps += 1;
    },
    ...over,
  };
  return { root, releases, cfg, clock };
}

test('ciGreen accepts only completed + success', () => {
  assert.equal(ciGreen(JSON.stringify({ status: 'completed', conclusion: 'success' })), true);
  assert.equal(ciGreen(JSON.stringify({ status: 'completed', conclusion: 'failure' })), false);
  assert.equal(ciGreen(JSON.stringify({ status: 'in_progress', conclusion: null })), false);
});

test('dry-run prints steps, exits 0, and leaves host/releases unchanged', () => {
  const before = existsSync(join(here, '..', 'releases')) ? readdirSync(join(here, '..', 'releases')) : null;
  const r = spawnSync(process.execPath, [deployBin, '--dry-run'], { encoding: 'utf8' });
  const after = existsSync(join(here, '..', 'releases')) ? readdirSync(join(here, '..', 'releases')) : null;
  assert.equal(r.status, 0);
  assert.match(r.stdout, /CI/);
  assert.deepEqual(after, before);
});

test('red main CI refuses and changes no pointer', async () => {
  const { releases, cfg } = sandbox({ ci: RED });
  await assert.rejects(deploy(cfg), /CI is not green/);
  assert.deepEqual(readdirSync(releases), []);
});

test('failing smoke suite refuses, removes the new version dir, and keeps active', async () => {
  const { releases, cfg } = sandbox({ smoke: 'node -e "process.exit(1)"' });
  writeFileSync(join(releases, 'active'), 'aaa1111\n');
  await assert.rejects(deploy(cfg), /smoke suite failed/);
  assert.deepEqual(readdirSync(releases).sort(), ['active']);
  assert.equal(readFileSync(join(releases, 'active'), 'utf8'), 'aaa1111\n');
});

test('fresh heartbeat keeps the new version and records previous', async () => {
  const { releases, cfg } = sandbox();
  mkdirSync(join(releases, 'aaa1111'));
  writeFileSync(join(releases, 'active'), 'aaa1111\n');
  writeFileSync(cfg.heartbeat, 'beat');
  utimesSync(cfg.heartbeat, (T0 + 500) / 1000, (T0 + 500) / 1000);
  const r = await deploy(cfg);
  assert.deepEqual(r, { version: 'bbb2222', rolledBack: false });
  assert.equal(readFileSync(join(releases, 'active'), 'utf8'), 'bbb2222\n');
  assert.equal(readFileSync(join(releases, 'previous'), 'utf8'), 'aaa1111\n');
  assert.deepEqual(readdirSync(releases).sort(), ['aaa1111', 'active', 'bbb2222', 'previous'].sort());
  assert.equal(existsSync(join(releases, 'ledger.jsonl')), false);
  assert.equal(existsSync(join(releases, 'active.tmp')), false);
});

test('no fresh heartbeat within 2 poll intervals rolls back and writes deploy-rollback', async () => {
  const { releases, cfg, clock } = sandbox();
  mkdirSync(join(releases, 'aaa1111'));
  writeFileSync(join(releases, 'active'), 'aaa1111\n');
  const r = await deploy(cfg);
  assert.deepEqual(r, { version: 'bbb2222', rolledBack: true });
  assert.equal(clock.sleeps, 2);
  assert.equal(clock.t - T0, 2000);
  assert.equal(readFileSync(join(releases, 'active'), 'utf8'), 'aaa1111\n');
  const [line] = readFileSync(join(releases, 'ledger.jsonl'), 'utf8').trim().split('\n');
  const entry = JSON.parse(line);
  assert.equal(entry.kind, 'deploy-rollback');
  assert.equal(entry.from, 'bbb2222');
  assert.equal(entry.to, 'aaa1111');
  assert.equal(typeof entry.reason, 'string');
  assert.equal(typeof entry.ts, 'number');
});
