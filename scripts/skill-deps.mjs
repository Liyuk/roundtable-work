import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { exists } from './install.mjs';

export const MANIFEST = resolve(import.meta.dirname, '..', 'practice', 'skills', 'manifest.json');
export const PIN_FILE = '.rt-pin';
const INSTALL_DIR = join('.agents', 'skills');
const SKILL_DIRS = [INSTALL_DIR, join('.claude', 'skills')];
const LICENSE_RECORD = join('.roundtable', 'skill-licenses.json');
const ALLOWED = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC'];
const LICENSE_TEXTS = [
  ['MIT', /MIT License/],
  ['Apache-2.0', /Apache License,? Version 2\.0/],
  ['BSD-3-Clause', /Redistribution and use[\s\S]*Neither the name/],
  ['BSD-2-Clause', /Redistribution and use/],
  ['ISC', /ISC License/],
  ['GPL', /GNU GENERAL PUBLIC LICENSE/],
];

// Trust boundary: the manifest is committed JSON whose ids become directory names and whose pins are passed to git.
export async function loadManifest(file = MANIFEST) {
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  for (const s of manifest.skills) {
    if (!/^[a-z0-9-]+$/.test(s.id) || !['required', 'optional'].includes(s.requirement)) throw new Error(`manifest: bad entry ${s.id}`);
    if ((s.pin !== null && !/^[0-9a-f]{40}$/.test(s.pin)) || (s.checksum !== null && !/^sha256:[0-9a-f]{64}$/.test(s.checksum))) throw new Error(`manifest: ${s.id} has a malformed pin or checksum`);
  }
  return manifest;
}

export async function treeChecksum(dir) {
  const hash = createHash('sha256');
  const files = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .filter((rel) => rel !== PIN_FILE)
    .sort();
  for (const rel of files) hash.update(`${rel}\0`).update(await readFile(join(dir, rel))).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

export function licenseOf(text) {
  return LICENSE_TEXTS.find(([, re]) => re.test(text ?? ''))?.[0] ?? null;
}

async function locate(target, id) {
  for (const dir of SKILL_DIRS) {
    if (await exists(join(target, dir, id, 'SKILL.md'))) return join(target, dir, id);
  }
  return null;
}

async function checkSkill(entry, target) {
  const dir = await locate(target, entry.id);
  if (!dir) return { status: 'missing' };
  if (entry.pin === null) return { status: 'refused', reason: 'no pin in manifest' };
  const pin = await readFile(join(dir, PIN_FILE), 'utf8').then((t) => t.trim(), () => null);
  if (pin !== entry.pin) return { status: 'refused', reason: 'pin mismatch' };
  if (await treeChecksum(dir) !== entry.checksum) return { status: 'refused', reason: 'checksum mismatch' };
  return { status: 'verified' };
}

function git(args) {
  const run = spawnSync('git', args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`git ${args[0]} failed: ${run.stderr.trim()}`);
}

// Clones the upstream source and checks out the pinned commit in a temporary directory; the caller cleans it up.
async function fetchPinned(entry) {
  const dir = await mkdtemp(join(tmpdir(), 'rt-skill-'));
  const src = join(dir, 'src');
  git(['clone', '--quiet', '--', entry.source.repo, src]);
  git(['-C', src, 'checkout', '--quiet', entry.pin]);
  return {
    license: await readFile(join(src, 'LICENSE'), 'utf8').catch(() => null),
    dir: join(src, entry.source.path),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function recordLicense(target, entry, license) {
  const file = join(target, LICENSE_RECORD);
  const record = await readFile(file, 'utf8').then(JSON.parse, () => ({}));
  record[entry.id] = { repo: entry.source.repo, pin: entry.pin, license };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

export async function installSkill(entry, target, fetch = fetchPinned) {
  if (!entry.pin || !entry.source) return { ok: false, reason: 'no pinned source in manifest' };
  const src = await fetch(entry);
  try {
    const license = licenseOf(src.license);
    await recordLicense(target, entry, license);
    if (!ALLOWED.includes(license)) return { ok: false, reason: license ? `incompatible license ${license}` : 'license missing or not recognized' };
    const dest = join(target, INSTALL_DIR, entry.id);
    await cp(src.dir, dest, { recursive: true });
    await writeFile(join(dest, PIN_FILE), `${entry.pin}\n`);
    if (await treeChecksum(dest) !== entry.checksum) {
      await rm(dest, { recursive: true, force: true });
      return { ok: false, reason: 'checksum mismatch after copy' };
    }
    return { ok: true };
  } finally {
    await src.cleanup();
  }
}

export async function askConsent(entry) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Install pinned skill ${entry.id} at ${entry.pin}? [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// Read-only unless the user consents to a pinned install of a missing required skill. Never throws for a missing skill.
export async function checkSkills({ manifest, target, consent = askConsent, install = installSkill }) {
  const skills = [];
  for (const entry of manifest.skills) {
    let { status, reason } = await checkSkill(entry, target);
    let installNote = null;
    if (status === 'missing' && entry.requirement === 'required' && entry.pin !== null && await consent(entry)) {
      const outcome = await install(entry, target).catch((e) => ({ ok: false, reason: e.message }));
      installNote = outcome.ok ? 'installed' : outcome.reason;
      ({ status, reason } = await checkSkill(entry, target));
    }
    const fallback = entry.requirement === 'required' && status !== 'verified' ? entry.fallback : null;
    skills.push({ id: entry.id, requirement: entry.requirement, status, reason: reason ?? null, install: installNote, fallback });
  }
  return { skills, fallbackUsed: skills.some((s) => s.fallback !== null) };
}
