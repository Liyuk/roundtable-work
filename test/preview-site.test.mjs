import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, createPreviewServer, resolveRequestPath } from '../scripts/preview-site.mjs';

const site = fileURLToPath(new URL('../site', import.meta.url));
const root = resolve(site);

test('maps / and the published files inside the root', () => {
  assert.equal(resolveRequestPath('/', root), join(root, 'index.html'));
  assert.equal(resolveRequestPath('/styles.css?v=1#x', root), join(root, 'styles.css'));
  assert.equal(resolveRequestPath('/app.js', root), join(root, 'app.js'));
});

test('rejects traversal in raw, encoded and mixed forms', () => {
  for (const target of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/a/../../x', '/%2E%2E%2F%2E%2E%2Fetc/passwd', '/..\\x', '/a%5C..%5Cb', '/%00', '/x%00.html', '/%zz', '/.git/config', '/.env']) {
    assert.equal(resolveRequestPath(target, root), null, target);
  }
});

test('absolute-looking and scheme-looking targets cannot leave the root', () => {
  for (const target of ['//etc/passwd', '/etc/passwd', 'http://localhost/x']) {
    const file = resolveRequestPath(target, root);
    assert.ok(file === null || file.startsWith(root + '/'), `${target} -> ${file}`);
  }
});

test('the server answers on loopback, is read-only and refuses other paths', async () => {
  const server = createPreviewServer(site);
  await new Promise((ok) => server.listen(0, HOST, ok));
  try {
    const { address, port } = server.address();
    assert.equal(address, '127.0.0.1');
    const base = `http://${HOST}:${port}`;
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.equal(await home.text(), readFileSync(join(site, 'index.html'), 'utf8'));
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/`, { method: 'HEAD' })).status, 200);
    assert.equal((await fetch(`${base}/`, { method: 'POST', body: 'x' })).status, 405);
    assert.equal((await fetch(`${base}/`, { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(`${base}/missing.html`)).status, 404);
    assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
    assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  } finally { await new Promise((ok) => server.close(ok)); }
});
