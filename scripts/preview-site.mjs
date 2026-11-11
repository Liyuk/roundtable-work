// Local preview of the static demo. No dependencies.
//
//   node scripts/preview-site.mjs        serves site/ on http://127.0.0.1:4173/
//   PORT=8080 node scripts/preview-site.mjs
//
// Read-only: GET and HEAD only, loopback only, only the published files, no directory listings.
import { createServer } from 'node:http';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

// Maps a request target to a file inside root, or returns null. Rejects encoded or raw "..", NUL,
// backslashes, absolute-looking segments, dotfiles and anything that resolves outside root.
export function resolveRequestPath(target, root) {
  let pathname;
  // Not parsed with URL: URL silently normalises "/../", and ".." should be refused, not rewritten.
  try { pathname = decodeURIComponent(String(target).split(/[?#]/)[0]); }
  catch { return null; }
  if (!pathname.startsWith('/')) return null;
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const segments = pathname.split('/').filter(Boolean);
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  const base = resolve(root);
  const file = resolve(base, segments.length ? join(...segments) : 'index.html');
  return file.startsWith(base + sep) ? file : null;
}

// Serves regular files only. Symlinks and directories are not served.
function regularFile(file) {
  try { return lstatSync(file).isFile(); } catch { return false; }
}

export function createPreviewServer(root) {
  return createServer((req, res) => {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end('Method not allowed\n');
      return;
    }
    const file = resolveRequestPath(req.url ?? '/', root);
    const type = file && TYPES[file.slice(file.lastIndexOf('.'))];
    if (!file || !type || !regularFile(file)) {
      res.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found\n');
      return;
    }
    const body = readFileSync(file);
    res.writeHead(200, { ...headers, 'Content-Type': type, 'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
}

function main() {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid PORT: ${process.env.PORT}`);
    process.exitCode = 1;
    return;
  }
  const root = fileURLToPath(new URL('../site', import.meta.url));
  const server = createPreviewServer(root);
  server.listen(port, HOST, () => console.log(`Previewing site/ at http://${HOST}:${server.address().port}/ (Ctrl+C to stop)`));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
