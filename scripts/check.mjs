import { readdir, readFile, access } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const skillDir = join(root, '.agents', 'skills', 'roundtable-work');
const ignored = new Set(['.git', 'node_modules', '.roundtable', '.claude']);
const errors = [];
let count = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile() && entry.name.endsWith('.md')) await checkFile(path);
  }
}

async function checkFile(path) {
  count++;
  const content = await readFile(path, 'utf8');
  const inSkill = path.startsWith(skillDir + sep);
  for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    const resolved = resolve(dirname(path), decodeURIComponent(target));
    const where = relative(root, path);
    try { await access(resolved); }
    catch { errors.push(`${where}：缺少 ${target}`); continue; }
    // 技能会被复制到其他工作区，因此不能链接到其自身以外的位置。
    if (inSkill && !resolved.startsWith(skillDir + sep)) errors.push(`${where}：技能链接到目录外：${target}`);
  }
}

await walk(root);
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`检查了 ${count} 个 Markdown 文件：本地链接均已解析，技能自成一体。`);
