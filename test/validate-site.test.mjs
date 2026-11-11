import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_FILES, validateDir, validateFiles } from '../scripts/validate-site.mjs';

const site = fileURLToPath(new URL('../site', import.meta.url));
const good = { 'index.html': '<a href="#x">x</a><link rel="stylesheet" href="styles.css">', 'styles.css': 'a { color: red; } /* note */', 'app.js': '// comment\nconsole.log("hi");' };
const with_ = (name, text) => ({ ...good, [name]: text });

test('the committed site passes validation', () => {
  assert.deepEqual(validateDir(site), []);
});

test('a clean set of allowed files passes', () => {
  assert.deepEqual(validateFiles(good), []);
});

test('files outside the allowlist and missing files are reported', () => {
  assert.match(validateFiles({ ...good, 'extra.txt': 'x' }).join('\n'), /extra\.txt: not in the allowlist/);
  const { 'app.js': _omit, ...rest } = good;
  assert.match(validateFiles(rest).join('\n'), /app\.js: missing/);
  assert.deepEqual(ALLOWED_FILES, ['index.html', 'styles.css', 'app.js']);
});

// Strings are assembled at run time so that this file does not itself contain a token-like literal.
const BAD = {
  'absolute http(s) URL': 'see ' + 'https' + '://example.com/x',
  'protocol-relative URL': '<script src="' + '//' + 'cdn.example/x.js"></script>',
  'file: URL': 'href="' + 'file' + ':///tmp/x"',
  'root-absolute reference': '<link href="/styles.css">',
  'root-absolute url()': 'a { background: url(/img.png); }',
  'local absolute path': 'at ' + '/home' + '/someone/x',
  'GitHub token': 'x = "' + 'ghp' + '_' + 'a'.repeat(12) + '"',
  'private key block': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  'IPv4 literal': 'host 10' + '.0.0.' + '7',
};
for (const [label, text] of Object.entries(BAD)) {
  test(`rejects: ${label}`, () => {
    for (const name of ALLOWED_FILES) {
      const problems = validateFiles(with_(name, text));
      assert.ok(problems.some((p) => p.startsWith(`${name}: `) && p.includes(label)), `${name} should report ${label}: ${problems}`);
    }
  });
}

test('problem messages never echo the matched secret text', () => {
  const token = 'ghp' + '_' + 'b'.repeat(20);
  assert.ok(!validateFiles(with_('app.js', token)).join('\n').includes(token));
});

test('ordinary comments and relative links are not false positives', () => {
  assert.deepEqual(validateFiles(with_('app.js', '// a comment\nconst a = 1; // trailing\n')), []);
  assert.deepEqual(validateFiles(with_('index.html', '<a href="#top">t</a> <link rel="icon" href="data:,">')), []);
});

test('validateDir reports subdirectories and symlinks without reading them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rt-validate-'));
  try {
    for (const [name, text] of Object.entries(good)) writeFileSync(join(dir, name), text);
    assert.deepEqual(validateDir(dir), []);
    mkdirSync(join(dir, 'sub'));
    symlinkSync(join(dir, 'index.html'), join(dir, 'link.html'));
    const problems = validateDir(dir).join('\n');
    assert.match(problems, /sub: not a regular file/);
    assert.match(problems, /link\.html: not a regular file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
