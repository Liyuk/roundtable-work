#!/usr/bin/env node
// rt-timers.mjs <root>: fires every due timer of <root> into its event inbox and prints the number of accepted events.
// rt-timers.mjs wait <root> <issue> <unblockAt>: a worker's `wait` decision writes its due timer (waitRelease); the worker exits.
import { openTimers, waitRelease } from '../../runtime/lib/event-timers.mjs';

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'wait') {
  const [root, issue, unblockAt] = args;
  waitRelease(root, { issue: Number(issue), input: { decision: 'wait', event: 'resume', unblockAt } });
} else {
  if (!cmd) {
    console.error('usage: node host/bin/rt-timers.mjs <root> | wait <root> <issue> <unblockAt>');
    process.exit(2);
  }
  console.log(openTimers(cmd).fire(Date.now()));
}
