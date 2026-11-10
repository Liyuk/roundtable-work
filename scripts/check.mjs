import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ignored = new Set(['.git', 'node_modules', '.roundtable']);
const errors = [];
let count = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      count++;
      const content = await readFile(path, 'utf8');
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1].split('#')[0];
        if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
        try { await access(resolve(dirname(path), decodeURIComponent(target))); }
        catch { errors.push(`${path.slice(root.length + 1)}: missing ${target}`); }
      }
    }
  }
}
await walk(root);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Checked ${count} Markdown files: local links resolve.`);
