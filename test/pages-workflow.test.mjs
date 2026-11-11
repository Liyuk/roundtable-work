import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Static checks of .github/workflows/pages.yml. No YAML parser: the file is read as text, comments are
// removed, and each job is cut out by its indentation. The workflow itself can only run on GitHub.
const raw = readFileSync(fileURLToPath(new URL('../.github/workflows/pages.yml', import.meta.url)), 'utf8');
const text = raw.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
const lines = text.split('\n');
const indentOf = (l) => l.match(/^ */)[0].length;

// Lines of the block that starts at lines[start] (a "key:" line): everything more indented than it.
function blockAfter(arr, start) {
  const base = indentOf(arr[start]);
  const out = [];
  for (let i = start + 1; i < arr.length; i++) {
    if (arr[i].trim() && indentOf(arr[i]) <= base) break;
    out.push(arr[i]);
  }
  return out;
}
const jobsAt = lines.findIndex((l) => /^jobs:\s*$/.test(l));
const jobBlock = (name) => {
  const jobs = blockAfter(lines, jobsAt);
  const at = jobs.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  assert.ok(at >= 0, `job ${name} exists`);
  return blockAfter(jobs, at);
};
// Normalised permission entries of a block ("contents: read"), or null if there is no permissions key.
function permissionsOf(block, indent) {
  const at = block.findIndex((l) => new RegExp(`^ {${indent}}permissions:`).test(l));
  if (at < 0) return null;
  const inline = block[at].split(':').slice(1).join(':').trim();
  if (inline) return inline === '{}' ? [] : [inline];
  return blockAfter(block, at).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean).sort();
}

const build = jobBlock('build');
const deploy = jobBlock('deploy');
const jobNames = lines.slice(jobsAt + 1).filter((l) => /^  [\w-]+:\s*$/.test(l)).map((l) => l.trim().slice(0, -1));

test('only the build and deploy jobs exist', () => {
  assert.deepEqual(jobNames, ['build', 'deploy']);
});

test('triggers: push to main, pull_request and manual dispatch; never pull_request_target', () => {
  assert.ok(!/pull_request_target/.test(text));
  const on = blockAfter(lines, lines.findIndex((l) => /^on:\s*$/.test(l))).join('\n');
  assert.match(on, /^ {2}push:\s*\n\s+branches:\s*\[\s*main\s*\]/m);
  assert.match(on, /^ {2}pull_request:/m);
  assert.match(on, /^ {2}workflow_dispatch:/m);
});

test('no secrets, no broad write, no self-hosted runners', () => {
  assert.ok(!/secrets\./i.test(text), 'no secrets.* references');
  assert.ok(!/write-all/.test(text));
  assert.ok(!/self-hosted/.test(text));
  for (const m of text.matchAll(/runs-on:\s*(.+)/g)) assert.match(m[1].trim(), /^ubuntu-/);
});

test('top-level permissions are explicit and grant nothing beyond read', () => {
  const top = permissionsOf(lines, 0);
  assert.ok(top !== null, 'top-level permissions are set explicitly');
  for (const p of top) assert.ok(p === 'contents: read', `unexpected top-level permission: ${p}`);
});

test('build job has only contents: read', () => {
  assert.deepEqual(permissionsOf(build, 4), ['contents: read']);
});

test('only the deploy job has pages: write and id-token: write', () => {
  assert.deepEqual(permissionsOf(deploy, 4), ['id-token: write', 'pages: write']);
  assert.ok(!/(pages|id-token):\s*write/.test(build.join('\n')));
  const writes = [...text.matchAll(/^\s+([\w-]+):\s*write\s*$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(writes, ['id-token', 'pages']);
});

test('deploy needs build, uses the github-pages environment and only runs from main (never for PRs)', () => {
  const d = deploy.join('\n');
  assert.match(d, /^ {4}needs:\s*(build|\[\s*build\s*\])\s*$/m);
  assert.match(d, /^ {4}if:\s*.*github\.event_name != 'pull_request'/m);
  assert.match(d, /^ {4}if:\s*.*github\.ref == 'refs\/heads\/main'/m);
  assert.match(d, /github-pages/);
  assert.match(d, /actions\/deploy-pages@/);
});

test('deploy concurrency never cancels a running deploy', () => {
  const d = deploy.join('\n');
  assert.match(d, /group:\s*pages\s*$/m);
  assert.match(d, /cancel-in-progress:\s*false\s*$/m);
  assert.ok(!/cancel-in-progress:\s*true/.test(d));
});

test('the build job runs tests, the drift check and artifact validation before upload, with no persisted credentials', () => {
  const b = build.join('\n');
  const at = (re) => { const m = b.search(re); assert.ok(m >= 0, `build step missing: ${re}`); return m; };
  const upload = at(/actions\/upload-pages-artifact@/);
  for (const re of [/run:\s*npm ci\b/, /run:\s*npm test\b/, /run:\s*npm run build:site -- --check\b/, /run:\s*npm run validate:site\b/]) {
    assert.ok(at(re) < upload, `${re} must come before the upload`);
  }
  assert.ok(at(/npm ci\b/) < at(/npm test\b/));
  assert.match(b, /actions\/checkout@[^\n]*\n\s+with:\s*\n\s+persist-credentials:\s*false/);
  assert.match(b, /node-version-file:\s*\.nvmrc/);
  assert.match(b, /cache:\s*npm/);
  assert.match(b, /timeout-minutes:\s*\d+/);
  assert.match(deploy.join('\n'), /timeout-minutes:\s*\d+/);
});

test('the artifact is the site directory only', () => {
  const paths = [...text.matchAll(/^\s+path:\s*(\S+)\s*$/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));
  assert.deepEqual(paths, ['site']);
});

test('every action is an official actions/* action pinned to a version tag', () => {
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(uses.length >= 5);
  for (const u of uses) assert.match(u, /^actions\/[\w-]+@v\d+$/, `unexpected action: ${u}`);
});
