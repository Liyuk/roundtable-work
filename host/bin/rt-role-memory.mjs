#!/usr/bin/env node
// rt-role-memory.mjs <role> < prompt: prints the prompt with the role's preloaded memory appended (same as rtd).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendMemory } from '../../runtime/rtd.mjs';
import { openMemoryStore } from '../../runtime/lib/memory-store.mjs';

const [role] = process.argv.slice(2);
const store = openMemoryStore({ dir: process.env.RT_ROLE_MEMORY_DIR || join(process.env.RT_HOME, 'state') });
process.stdout.write(appendMemory(readFileSync(0, 'utf8'), { store, role }));
