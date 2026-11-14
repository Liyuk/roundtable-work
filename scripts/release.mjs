#!/usr/bin/env node
// Export a git commit into <base>/releases/<sha>, optionally pointing <base>/current at it.
// Dry-run unless --apply is given.
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { assertCurrentReplaceable, replaceCurrentLink } from '../runtime/lib/release.mjs';

const defaultBase = () => (process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, 'rtd')
  : join(homedir(), '.local', 'share', 'rtd'));

function fullSha(rev) {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`unknown revision: ${rev}`);
  return res.stdout.trim();
}

const exited = (child) => new Promise((done) => child.on('close', done));

async function exportTree(sha, dest, base) {
  const tmp = join(base, 'releases', `.${sha}.tmp-${process.pid}`);
  try {
    await mkdir(tmp);
    const archive = spawn('git', ['archive', '--format=tar', sha], { stdio: ['ignore', 'pipe', 'inherit'] });
    const untar = spawn('tar', ['-x', '-C', tmp], { stdio: ['pipe', 'inherit', 'inherit'] });
    archive.stdout.pipe(untar.stdin);
    const [archiveCode, untarCode] = await Promise.all([
      exited(archive),
      exited(untar).then((code) => { if (code) archive.kill(); return code; }),
    ]);
    if (archiveCode || untarCode) throw new Error(`export failed (git archive ${archiveCode}, tar ${untarCode})`);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      sha: { type: 'string', default: 'HEAD' },
      apply: { type: 'boolean', default: false },
      'point-current': { type: 'boolean', default: false },
    },
  });
  const base = resolve(values.base ?? defaultBase());
  const sha = fullSha(values.sha);
  const release = join(base, 'releases', sha);

  if (!values.apply) {
    console.log(`plan: export ${sha} to ${release}`);
    if (values['point-current']) console.log(`plan: point ${join(base, 'current')} at ${release}`);
    console.log('dry-run: pass --apply to write');
    return;
  }

  if (values['point-current']) await assertCurrentReplaceable(base);
  await mkdir(join(base, 'releases'), { recursive: true });
  if (await lstat(release).then(() => true, () => false)) throw new Error(`${release} already exists`);
  await exportTree(sha, release, base);
  console.log(`exported ${sha} to ${release}`);
  if (values['point-current']) {
    const current = await replaceCurrentLink(base, sha);
    console.log(`current -> ${current.sha}`);
  }
}

main().catch((err) => {
  console.error(`release: ${err.message}`);
  process.exit(1);
});
