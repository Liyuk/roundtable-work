#!/usr/bin/env node
// Fires every due timer of <root> into its event inbox and prints the number of accepted events.
import { openTimers } from '../../runtime/lib/event-timers.mjs';

const root = process.argv[2];
if (!root) {
  console.error('usage: node host/bin/rt-timers.mjs <root>');
  process.exit(2);
}
console.log(openTimers(root).fire(Date.now()));
