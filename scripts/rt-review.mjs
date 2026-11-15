#!/usr/bin/env node
// In-repo entry point for independent review: runs the reviewer role's configured harness as a separate session.
import { pathToFileURL } from 'node:url';
import { reviewMain } from './rt-entry.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await reviewMain(process.argv.slice(2));
}
