import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, PIN_FILE, checkSkills, installSkill, licenseOf, loadManifest, treeChecksum } from '../scripts/skill-deps.mjs';

const cli = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
const PIN = 'a'.repeat(40);
const MIT = 'MIT License\n\nCopyright (c) 2026 Fixture\n';
const GPL = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n';
const REQUIRED = ['tdd', 'diagnosing-bugs', 'prove-it-works', 'blast-radius', 'architect', 'sequence-verifiable-units', 'implement', 'code-review', 'correct', 'show-me-your-work'];
const OPTIONAL = ['arena', 'swarm', 'interrogate', 'formal-verification', 'figure-it-out'];

const target = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rtw-skilldeps-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function putSkill(dir, id, { pin = PIN, body = '---\nname: x\n---\n' } = {}) {
  const path = join(dir, '.agents', 'skills', id);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), body);
  if (pin !== null) writeFileSync(join(path, PIN_FILE), `${pin}\n`);
  return path;
}
const entryFor = (id, checksum, extra = {}) => ({ id, name: id, requirement: 'required', roles: ['developer'], source: { repo: 'fixture/repo', path: id }, pin: PIN, checksum, fallback: 'distilled-core', ...extra });
const noConsent = () => { throw new Error('consent must not be asked'); };
const fakeFetch = (license, dir) => async () => ({ license, dir, cleanup: async () => {} });

test('manifest lists each required and optional skill with pin, checksum and fallback fields', async () => {
  const { skills } = await loadManifest(MANIFEST);
  const ids = (req) => skills.filter((s) => s.requirement === req).map((s) => s.id).sort();
  assert.deepEqual(ids('required'), [...REQUIRED].sort());
  assert.deepEqual(ids('optional'), [...OPTIONAL].sort());
  for (const s of skills) {
    assert.ok(Array.isArray(s.roles) && s.name && 'source' in s && 'pin' in s && 'checksum' in s, s.id);
    assert.equal(s.pin, null, `${s.id}: no real upstream pin was resolved, so pin must stay null`);
    assert.equal(s.checksum, null);
    assert.equal(s.fallback, s.requirement === 'required' ? 'distilled-core' : 'skip');
  }
});

test('the repository vendors no upstream skill tree and new files carry no host-specific values', () => {
  assert.deepEqual(readdirSync(join(root, 'practice', 'skills')), ['manifest.json']);
  const files = [MANIFEST, join(root, 'scripts', 'skill-deps.mjs'), join(root, 'docs', 'skill-dependencies.md')];
  const forbidden = /\/home\/|\/Users\/|[A-Za-z]:\\|https?:\/\/|\b\d{1,3}(\.\d{1,3}){3}\b|\.(com|net|org|io)\b/;
  const publicSources = /https:\/\/github\.com\/(cursor\/plugins|mattpocock\/skills)\b/g;
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8').replace(publicSources, ''), forbidden, file);
});

test('required skill present and verified at pin continues normally; absent optional skill is ignored', async (t) => {
  const dir = target(t);
  const path = putSkill(dir, 'tdd');
  const checksum = await treeChecksum(path);
  const manifest = { skills: [entryFor('tdd', checksum), { ...entryFor('arena', null), requirement: 'optional', fallback: 'skip' }] };
  const result = await checkSkills({ manifest, target: dir, consent: noConsent });
  assert.deepEqual(result.skills.map((s) => [s.id, s.status, s.fallback]), [['tdd', 'verified', null], ['arena', 'missing', null]]);
  assert.equal(result.fallbackUsed, false);
});

test('missing required skill: consent offers a pinned install; refusal, failure, or unattended keeps the loop running on fallback', async (t) => {
  const dir = target(t);
  const manifest = { skills: [entryFor('tdd', 'sha256:' + '0'.repeat(64))] };
  const offered = [];
  const refused = await checkSkills({ manifest, target: dir, consent: async (e) => (offered.push(e.id), false), install: noConsent });
  assert.deepEqual(offered, ['tdd']);
  assert.equal(refused.skills[0].status, 'missing');
  assert.equal(refused.skills[0].fallback, 'distilled-core');
  const failed = await checkSkills({ manifest, target: dir, consent: async () => true, install: async () => { throw new Error('network down'); } });
  assert.match(failed.skills[0].install, /network down/);
  assert.equal(failed.fallbackUsed, true);
  const unattended = execFileSync(process.execPath, [cli, '--target', dir], { encoding: 'utf8' });
  assert.match(unattended, /fallback will be used; the loop keeps running/);
});

test('integrity or pin mismatch refuses that copy and follows fallback without offering install', async (t) => {
  const dir = target(t);
  const wrongPin = putSkill(dir, 'tdd', { pin: 'b'.repeat(40) });
  const checksum = await treeChecksum(wrongPin);
  const pinMismatch = await checkSkills({ manifest: { skills: [entryFor('tdd', checksum)] }, target: dir, consent: noConsent });
  assert.equal(pinMismatch.skills[0].status, 'refused');
  assert.equal(pinMismatch.skills[0].reason, 'pin mismatch');
  assert.equal(pinMismatch.skills[0].fallback, 'distilled-core');

  const dir2 = target(t);
  putSkill(dir2, 'tdd');
  const tampered = await checkSkills({ manifest: { skills: [entryFor('tdd', 'sha256:' + '0'.repeat(64))] }, target: dir2, consent: noConsent });
  assert.equal(tampered.skills[0].reason, 'checksum mismatch');
  assert.equal(tampered.fallbackUsed, true);
});

test('license is recorded from the pinned commit before install; missing or incompatible license blocks install', async (t) => {
  assert.equal(licenseOf(null), null);
  assert.equal(licenseOf(MIT), 'MIT');
  assert.equal(licenseOf(GPL), 'GPL');
  const dir = target(t);
  const src = putSkill(join(dir, 'upstream'), 'tdd', { pin: null });
  const entry = entryFor('tdd', await treeChecksum(src));
  const dest = join(dir, '.agents', 'skills', 'tdd');
  const licenses = join(dir, '.roundtable', 'skill-licenses.json');

  const missing = await installSkill(entry, dir, fakeFetch(null, src));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /license missing/);
  assert.equal(existsSync(dest), false);
  assert.equal(JSON.parse(readFileSync(licenses, 'utf8')).tdd.license, null);

  const gpl = await installSkill(entry, dir, fakeFetch(GPL, src));
  assert.equal(gpl.reason, 'incompatible license GPL');
  assert.equal(existsSync(dest), false);

  const ok = await installSkill(entry, dir, fakeFetch(MIT, src));
  assert.equal(ok.ok, true);
  assert.equal(readFileSync(join(dest, PIN_FILE), 'utf8').trim(), PIN);
  assert.equal(JSON.parse(readFileSync(licenses, 'utf8')).tdd.license, 'MIT');
});

test('unpinned entries are never installed', async (t) => {
  const outcome = await installSkill(entryFor('tdd', null, { pin: null }), target(t), noConsent);
  assert.deepEqual(outcome, { ok: false, reason: 'no pinned source in manifest' });
});
