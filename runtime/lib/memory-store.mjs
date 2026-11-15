import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// File-backed store for role memory (the contract role-memory.mjs uses: save/get/update/remove/list, insertion order).
// `<dir>/memory.jsonl` holds the rows and is rewritten through a temp file + rename on every change; `log.append`
// adds one line to `<dir>/memory-fetch.jsonl`.
export function openMemoryStore({ dir }) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'memory.jsonl');
  const rows = new Map();
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) if (line) { const row = JSON.parse(line); rows.set(row.id, row); }
  const persist = () => {
    writeFileSync(`${file}.tmp`, [...rows.values()].map((row) => `${JSON.stringify(row)}\n`).join(''));
    renameSync(`${file}.tmp`, file);
  };
  return {
    save(row) { rows.set(row.id, row); persist(); },
    get: (id) => rows.get(id),
    update(id, patch) { Object.assign(rows.get(id), patch); persist(); },
    remove(id) { rows.delete(id); persist(); },
    list: () => [...rows.values()],
    log: { append(entry) { appendFileSync(join(dir, 'memory-fetch.jsonl'), `${JSON.stringify(entry)}\n`); } },
  };
}
