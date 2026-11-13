import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Static checks of .github/workflows/check.yml. No YAML parser: the file is read as text,
// full-line comments are removed, and the matrix/step blocks are matched structurally.
const raw = readFileSync(fileURLToPath(new URL('../.github/workflows/check.yml', import.meta.url)), 'utf8');
const text = raw.split('\n').map((l) => l.replace(/^\s*#.*$/, '')).join('\n');
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
assert.ok(jobsAt >= 0, 'jobs: block exists');
const jobBlock = (name) => {
  const jobs = blockAfter(lines, jobsAt);
  const at = jobs.findIndex((l) => new RegExp(`^  ${name}:\\s*$`).test(l));
  assert.ok(at >= 0, `job ${name} exists`);
  return blockAfter(jobs, at);
};

const check = jobBlock('check');
const checkText = check.join('\n');

test('check runs on ubuntu plus an Intel macOS image, never the arm64 macos-latest pool', () => {
  const matrixAt = check.findIndex((l) => /^\s*matrix:\s*$/.test(l));
  assert.ok(matrixAt >= 0, 'matrix block exists');
  const osLine = blockAfter(check, matrixAt).find((l) => /^\s*os:\s*\[/.test(l));
  assert.ok(osLine, 'matrix.os is declared');
  const os = [...osLine.matchAll(/[A-Za-z0-9_.-]+/g)].map((m) => m[0]).filter((v) => v !== 'os');
  assert.deepEqual(os, ['ubuntu-latest', 'macos-26-intel']);
  // Regression for #28 CI: macos-latest resolves to the arm64 image whose runner pool is
  // capacity-constrained; a revert to it would leave required checks cancelled before a runner
  // is acquired. The macOS leg must stay pinned to an Intel (x64) runner label.
  assert.ok(!os.includes('macos-latest'), 'macos-latest (arm64) must not be used');
  const mac = os.filter((v) => v.startsWith('macos-'));
  assert.equal(mac.length, 1);
  assert.match(mac[0], /^macos-\d+-intel$/, 'macOS image must use an Intel (x64) runner label');
});

test('jobs run through the matrix and never fail fast, so a flaky OS cannot cancel the other', () => {
  assert.match(checkText, /runs-on:\s*\${{ matrix\.os }}/);
  assert.match(checkText, /fail-fast:\s*false/);
});

test('the macOS job still proves path confinement works without /proc', () => {
  assert.ok(checkText.includes('Verify macOS has no /proc'), 'no-/proc step exists');
  assert.match(checkText, /if:\s*runner\.os == 'macOS'/);
  assert.match(checkText, /run:\s*test ! -e \/proc/);
});

test('the test and install steps are unchanged', () => {
  assert.match(checkText, /run:\s*npm ci\b/);
  assert.match(checkText, /run:\s*npm test\b/);
});
