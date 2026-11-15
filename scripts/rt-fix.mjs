#!/usr/bin/env node
// In-repo entry point for a bug fix without an issue number: runs the implementer role's configured harness once.
import { pathToFileURL } from 'node:url';
import { fixMain } from './rt-entry.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await fixMain(process.argv.slice(2));
}
