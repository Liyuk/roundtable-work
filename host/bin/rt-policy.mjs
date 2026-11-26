#!/usr/bin/env node
// rt-policy.mjs role <name> | security (stdin: changed paths) | ask <DECISION file>
// Host-side calls into runtime/lib, so the shell layer uses the runtime's role aliases, security trigger set and ask policy.
// role: prints the canonical role for a standing role or legacy alias (exits 1 with a RoutingError for an unknown name).
// security: prints the first changed path in the security trigger set (nothing when none matches).
// ask: prints the resolveAsk result as JSON for a DECISION card (line 2 category; optional `options:` and `recommendation:` lines).
// A goal change (scope ask) is never resolved: it prints block/goal-change.
import { readFileSync } from 'node:fs';
import { resolveRole } from '../../runtime/lib/routing.mjs';
import { securityTriggers } from '../../runtime/lib/security-triggers.mjs';
import { isGoalChange, resolveAsk } from '../../runtime/lib/ask-policy.mjs';

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'role') {
  process.stdout.write(`${resolveRole(arg)}\n`);
} else if (cmd === 'security') {
  const hit = readFileSync(0, 'utf8').split('\n').find((file) => file && securityTriggers([file]));
  if (hit) process.stdout.write(`${hit}\n`);
} else if (cmd === 'ask') {
  const lines = readFileSync(arg, 'utf8').split('\n');
  const field = (name) => lines.find((line) => line.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim();
  const card = {
    category: lines[1]?.trim().toLowerCase(),
    question: lines.slice(2).join('\n'),
    recommendation: field('recommendation'),
    options: field('options')?.split('|').map((option) => option.trim()),
  };
  const verdict = isGoalChange(card) ? { outcome: 'block', reason: 'goal-change' } : resolveAsk({ card });
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
} else {
  process.stderr.write('usage: rt-policy.mjs role <name> | security | ask <DECISION file>\n');
  process.exit(2);
}
