import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { main } from '../bin/rtd';

const root = resolve(import.meta.dirname, '..');
const fixtures = join(root, 'test/fixtures/rtd-install');
const PLIST = 'io.roundtable.rtd.plist';
const MANIFEST = 'rtd-install.manifest.json';
const INSTALL_ARGS = [
  '--workspace', '/opt/example/workspace',
  '--env-path', '/opt/example/rtd.env',
  '--handler', '/opt/example/workspace/handler.mjs',
  '--providers', '/opt/example/workspace/providers.mjs',
  '--routing', '/opt/example/routing.json',
  '--alert-issue', '1',
];
const HOME_PATH = /\/home\/|\/Users\/|\/root\//;
const IPV4 = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;

// In-process with platform forced to darwin; the unit dir is always a tmp dir.
async function rtd(args) {
  const out = [];
  const err = [];
  const status = await main(args, {
    platform: 'darwin',
    env: {},
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
  });
  return { status, stdout: out.join(''), stderr: err.join('') };
}

function assertClean(text) {
  assert.doesNotMatch(text, HOME_PATH);
  assert.doesNotMatch(text, IPV4);
}

async function withUnitDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rtd-test-'));
  try {
    await fn(join(dir, 'LaunchAgents'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('install writes the launchd plist byte-identical to the fixture', () => withUnitDir(async (unitDir) => {
  const r = await rtd(['install', ...INSTALL_ARGS, '--unit-dir', unitDir]);
  assert.equal(r.status, 0, r.stderr);
  assertClean(r.stdout);
  const generated = await readFile(join(unitDir, PLIST), 'utf8');
  assert.equal(generated, await readFile(join(fixtures, PLIST), 'utf8'));
  assertClean(generated);
  const manifest = JSON.parse(await readFile(join(unitDir, MANIFEST), 'utf8'));
  assert.deepEqual(manifest, { schemaVersion: 1, files: [PLIST] });
}));

test('install --dry-run writes no files and creates no unit dir', () => withUnitDir(async (unitDir) => {
  const r = await rtd(['install', '--dry-run', ...INSTALL_ARGS, '--unit-dir', unitDir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<key>ProgramArguments<\/key>/);
  assertClean(r.stdout);
  await assert.rejects(access(unitDir), { code: 'ENOENT' });
}));

test('uninstall removes only the manifest-listed files and keeps user files', () => withUnitDir(async (unitDir) => {
  assert.equal((await rtd(['install', ...INSTALL_ARGS, '--unit-dir', unitDir])).status, 0);
  await writeFile(join(unitDir, 'user-note.txt'), 'keep me');
  const r = await rtd(['uninstall', '--unit-dir', unitDir]);
  assert.equal(r.status, 0, r.stderr);
  assertClean(r.stdout);
  assert.deepEqual(await readdir(unitDir), ['user-note.txt']);
  assert.equal(await readFile(join(unitDir, 'user-note.txt'), 'utf8'), 'keep me');
}));
